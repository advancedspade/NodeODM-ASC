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

        app.get("/auth/logout", (req, res) => {
            res.clearCookie(cookieName, { path: "/", sameSite: "lax" });
            res.redirect(302, "/login.html");
        });
    }

    return { attach, hasWebAuth, readWebSession, issueSessionJwt, verifySessionJwt, cookieName };
};
