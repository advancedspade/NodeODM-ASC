/*
 * Google OAuth2 (authorization code) routes and helpers for NodeODM web UI.
 */
"use strict";

const https = require("https");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const fs = require("fs");
const logger = require("./logger");
const path = require("path");

/** Prefer public/ (Docker + static); fall back to views/ for older trees. */
function resolveLoginHtmlPath() {
    const inPublic = path.join(__dirname, "..", "public", "login.html");
    const inViews = path.join(__dirname, "..", "views", "login.html");
    if (fs.existsSync(inPublic)) return inPublic;
    if (fs.existsSync(inViews)) return inViews;
    return inPublic;
}

function httpsGetJson(urlStr, headers) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const req = https.request(
            {
                hostname: u.hostname,
                path: u.pathname + u.search,
                method: "GET",
                headers: headers || {}
            },
            res => {
                let body = "";
                res.on("data", chunk => {
                    body += chunk;
                });
                res.on("end", () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        return reject(new Error("HTTP " + res.statusCode));
                    }
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on("error", reject);
        req.end();
    });
}

function cookieOpts(config, maxAgeMs) {
    const secure =
        process.env.OAUTH_COOKIE_SECURE === "0"
            ? false
            : process.env.OAUTH_COOKIE_SECURE === "1" ||
              process.env.NODE_ENV === "production";
    return {
        httpOnly: true,
        secure,
        sameSite: "lax",
        path: "/",
        maxAge: maxAgeMs
    };
}

function emailAllowed(email, domains) {
    if (!domains || !domains.length) return true;
    const e = String(email || "").toLowerCase();
    const at = e.indexOf("@");
    if (at === -1) return false;
    const host = e.slice(at + 1);
    return domains.some(d => host === d);
}

function portalOriginFromOAuthRedirect(config) {
    try {
        return new URL(config.oauthGoogleRedirectUri || "").origin;
    } catch (e) {
        return "";
    }
}

function siblingPortalOrigin(config) {
    const mine = portalOriginFromOAuthRedirect(config);
    const st = config.portalStagingEnvOrigin || "";
    const su = config.portalSuperEnvOrigin || "";
    if (!mine || !st || !su) return "";
    if (mine === st) return su;
    if (mine === su) return st;
    return "";
}

function crossSsoEnabled(config) {
    const mine = portalOriginFromOAuthRedirect(config);
    if (!mine || !config.portalStagingEnvOrigin || !config.portalSuperEnvOrigin) return false;
    return mine === config.portalStagingEnvOrigin || mine === config.portalSuperEnvOrigin;
}

function validatePortalNextUrl(config, urlStr) {
    try {
        const u = new URL(String(urlStr || ""));
        const allowed = [config.portalStagingEnvOrigin, config.portalSuperEnvOrigin].filter(Boolean);
        const ok = allowed.some(o => {
            try {
                return new URL(o).origin === u.origin;
            } catch (e2) {
                return false;
            }
        });
        if (!ok) return null;
        return u.origin + u.pathname + u.search;
    } catch (e) {
        return null;
    }
}

function publicAppBaseUrl(req) {
    const xfProto = (req.get("x-forwarded-proto") || "").split(",")[0].trim();
    const proto = xfProto || req.protocol || "https";
    const host = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
    if (!host) return null;
    return `${proto}://${host}/`;
}

module.exports = function createGoogleOAuth(config) {
    const cookieName = config.oauthCookieName || "ndm_oauth";
    const client = new OAuth2Client(
        config.oauthGoogleClientId,
        config.oauthGoogleClientSecret,
        config.oauthGoogleRedirectUri
    );

    function oauthSessionExpiresIn() {
        const days = Math.min(365, Math.max(1, parseInt(config.oauthSessionDays, 10) || 30));
        return String(days) + "d";
    }

    function oauthSessionCookieMaxAgeMs() {
        const days = Math.min(365, Math.max(1, parseInt(config.oauthSessionDays, 10) || 30));
        return days * 24 * 60 * 60 * 1000;
    }

    function issueSessionJwt(email, sub) {
        return jwt.sign(
            { email, v: 1 },
            config.sessionSecret,
            { expiresIn: oauthSessionExpiresIn(), subject: String(sub) }
        );
    }

    function verifySessionJwt(token) {
        if (!token) return null;
        try {
            return jwt.verify(token, config.sessionSecret);
        } catch (e) {
            return null;
        }
    }

    function issueBridgeJwt(email, sub) {
        return jwt.sign(
            { purpose: "sso-bridge", email: String(email), sub: String(sub) },
            config.sessionSecret,
            { expiresIn: "3m" }
        );
    }

    function hasWebAuth(req) {
        const c = req.cookies && req.cookies[cookieName];
        if (verifySessionJwt(c)) return true;
        if (config.token && req.query.token === config.token) return true;
        if (verifySessionJwt(req.query.token)) return true;
        return false;
    }

    function sessionFromPayload(p) {
        if (!p || !p.email) return null;
        const sub = p.sub != null ? String(p.sub) : "";
        if (!sub) return null;
        return { email: String(p.email), sub };
    }

    // Same auth sources as hasWebAuth, minus the shared API token (no identity).
    function readWebSession(req) {
        const c = req.cookies && req.cookies[cookieName];
        return sessionFromPayload(verifySessionJwt(c)) ||
            sessionFromPayload(verifySessionJwt(req.query && req.query.token));
    }

    function attach(app) {
        const loginPage = resolveLoginHtmlPath();
        if (!fs.existsSync(loginPage)) {
            logger.error(
                "OAuth: login page missing. Add public/login.html (or views/login.html). Tried: " + loginPage
            );
        }

        app.get("/login.html", (req, res) => {
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.sendFile(loginPage);
        });

        /**
         * Signed-in user switches host: mint bridge JWT on this origin (cookie), redirect to sibling /auth/session-bridge.
         * Query: dest=staging|super (portal hosts from config).
         */
        app.get("/auth/switch-site", (req, res) => {
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            res.setHeader("Pragma", "no-cache");
            const raw = String(req.query.dest || req.query.target || "")
                .toLowerCase()
                .trim();
            let destOriginRaw = "";
            if (raw === "staging" || raw === "st" || raw === "dronemaps") {
                destOriginRaw = config.portalStagingEnvOrigin || "";
            } else if (raw === "super" || raw === "su" || raw === "superdrone") {
                destOriginRaw = config.portalSuperEnvOrigin || "";
            }
            let destOrigin = "";
            try {
                destOrigin = destOriginRaw ? new URL(destOriginRaw.replace(/\/+$/, "") + "/").origin : "";
            } catch (e0) {
                destOrigin = "";
            }
            if (!destOrigin) {
                return res.redirect(302, "/login.html");
            }
            let reqOrigin = "";
            try {
                const b = publicAppBaseUrl(req);
                if (b) reqOrigin = new URL(b).origin;
            } catch (e1) {
                reqOrigin = "";
            }
            if (reqOrigin && reqOrigin === destOrigin) {
                return res.redirect(302, "/");
            }
            const loginOnDest = destOrigin + "/login.html";
            const session = readWebSession(req);
            if (!session || !crossSsoEnabled(config)) {
                return res.redirect(302, loginOnDest);
            }
            const nextSafe = validatePortalNextUrl(config, destOrigin + "/");
            if (!nextSafe) {
                return res.redirect(302, loginOnDest);
            }
            const bridge = issueBridgeJwt(session.email, session.sub);
            const u =
                destOrigin +
                "/auth/session-bridge?token=" +
                encodeURIComponent(bridge) +
                "&next=" +
                encodeURIComponent(nextSafe);
            return res.redirect(302, u);
        });

        app.get("/auth/google", (req, res) => {
            const state = jwt.sign({ t: Date.now() }, config.sessionSecret, { expiresIn: "10m" });
            const redirectUri = config.oauthGoogleRedirectUri;
            const url = client.generateAuthUrl({
                access_type: "online",
                redirect_uri: redirectUri,
                scope: [
                    "openid",
                    "https://www.googleapis.com/auth/userinfo.email",
                    "https://www.googleapis.com/auth/userinfo.profile"
                ],
                prompt: "select_account",
                state
            });
            res.redirect(302, url);
        });

        app.get("/auth/google/callback", async (req, res) => {
            if (req.query.error) {
                logger.warn("Google OAuth error: " + req.query.error);
                return res.redirect(302, "/login.html?error=" + encodeURIComponent(req.query.error));
            }
            try {
                jwt.verify(req.query.state || "", config.sessionSecret);
            } catch (e) {
                return res.redirect(302, "/login.html?error=invalid_state");
            }
            const code = req.query.code;
            if (!code) {
                return res.redirect(302, "/login.html?error=missing_code");
            }
            try {
                const { tokens } = await client.getToken({
                    code,
                    redirect_uri: config.oauthGoogleRedirectUri
                });
                client.setCredentials(tokens);
                let profile;
                try {
                    profile = await httpsGetJson("https://www.googleapis.com/oauth2/v2/userinfo", {
                        Authorization: "Bearer " + tokens.access_token
                    });
                } catch (e) {
                    logger.error("userinfo failed: " + e.message);
                    return res.redirect(302, "/login.html?error=userinfo");
                }
                const email = profile.email;
                const sub = profile.id || profile.sub;
                if (!email || !sub) {
                    return res.redirect(302, "/login.html?error=no_profile");
                }
                if (!emailAllowed(email, config.oauthAllowedDomains)) {
                    logger.warn("OAuth login denied for domain: " + email);
                    return res.redirect(302, "/login.html?error=forbidden_domain");
                }
                const sessionJwt = issueSessionJwt(email, sub);
                res.cookie(cookieName, sessionJwt, cookieOpts(config, oauthSessionCookieMaxAgeMs()));
                const sibling = siblingPortalOrigin(config);
                const mineOrigin = portalOriginFromOAuthRedirect(config);
                const nextAfter =
                    validatePortalNextUrl(config, publicAppBaseUrl(req)) ||
                    (mineOrigin ? validatePortalNextUrl(config, mineOrigin + "/") : null) ||
                    "/";
                if (crossSsoEnabled(config) && sibling) {
                    const bridge = issueBridgeJwt(email, sub);
                    const target =
                        sibling +
                        "/auth/session-bridge?token=" +
                        encodeURIComponent(bridge) +
                        "&next=" +
                        encodeURIComponent(nextAfter);
                    return res.redirect(302, target);
                }
                return res.redirect(302, "/");
            } catch (err) {
                const googleBody = err && err.response && err.response.data;
                const detail = googleBody
                    ? JSON.stringify(googleBody)
                    : (err && err.message) || String(err);
                logger.error("OAuth token exchange failed: " + detail);
                return res.redirect(302, "/login.html?error=token_exchange");
            }
        });

        app.get("/auth/session-bridge", (req, res) => {
            const mineOrigin = portalOriginFromOAuthRedirect(config);
            const nextFallback =
                validatePortalNextUrl(config, publicAppBaseUrl(req)) ||
                (mineOrigin ? validatePortalNextUrl(config, mineOrigin + "/") : null) ||
                "/";
            const nextRaw = req.query.next;
            const nextSafe = validatePortalNextUrl(config, nextRaw) || nextFallback;
            try {
                const payload = jwt.verify(String(req.query.token || ""), config.sessionSecret);
                if (payload.purpose !== "sso-bridge" || !payload.email || payload.sub == null) {
                    return res.redirect(302, "/login.html?error=bridge_invalid");
                }
                if (!emailAllowed(payload.email, config.oauthAllowedDomains)) {
                    return res.redirect(302, "/login.html?error=forbidden_domain");
                }
                const sessionJwt = issueSessionJwt(payload.email, String(payload.sub));
                res.cookie(cookieName, sessionJwt, cookieOpts(config, oauthSessionCookieMaxAgeMs()));
                return res.redirect(302, nextSafe);
            } catch (e) {
                logger.warn("session-bridge: " + (e && e.message));
                return res.redirect(302, "/login.html?error=bridge_invalid");
            }
        });

        app.get("/auth/logout", (req, res) => {
            res.clearCookie(cookieName, { path: "/", sameSite: "lax" });
            const sibling = siblingPortalOrigin(config);
            const mineOrigin = portalOriginFromOAuthRedirect(config);
            const back =
                validatePortalNextUrl(config, req.query.next) ||
                validatePortalNextUrl(config, publicAppBaseUrl(req)) ||
                (mineOrigin ? validatePortalNextUrl(config, mineOrigin + "/") : null) ||
                "/";
            if (crossSsoEnabled(config) && sibling && req.query.sibling_done !== "1") {
                const u =
                    sibling +
                    "/auth/logout?sibling_done=1&next=" +
                    encodeURIComponent(String(back));
                return res.redirect(302, u);
            }
            res.redirect(302, String(back));
        });
    }

    return { attach, hasWebAuth, readWebSession, issueSessionJwt, verifySessionJwt, cookieName };
};
