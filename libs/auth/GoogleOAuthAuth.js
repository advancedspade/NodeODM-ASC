/*
 * Cookie + optional query JWT session auth after Google OAuth, with optional legacy static token.
 */
"use strict";

const jwt = require("jsonwebtoken");
const TokenAuthBase = require("./TokenAuthBase");
const logger = require("../logger");

module.exports = class GoogleOAuthAuth extends TokenAuthBase {
    constructor(config) {
        super(config.token || "");
        this.config = config;
    }

    initialize(cb) {
        logger.info("Authentication using GoogleOAuth (cookie session; optional legacy --token)");
        cb();
    }

    verifySessionJwt(token) {
        if (!token) return null;
        try {
            return jwt.verify(token, this.config.sessionSecret);
        } catch (e) {
            return null;
        }
    }

    validateToken(token, cb) {
        if (this.config.token && token === this.config.token) {
            return cb(null, true);
        }
        const payload = this.verifySessionJwt(token);
        if (payload && payload.sub) {
            return cb(null, true);
        }
        cb(new Error("invalid or missing token"), false);
    }

    getMiddleware() {
        const cookieName = this.config.oauthCookieName || "ndm_oauth";
        return (req, res, next) => {
            const fromCookie = req.cookies && req.cookies[cookieName];
            const cookiePayload = this.verifySessionJwt(fromCookie);
            if (cookiePayload && cookiePayload.sub) {
                req.oauthUser = { email: cookiePayload.email, sub: cookiePayload.sub };
                return next();
            }
            if (this.config.token && req.query.token === this.config.token) {
                return next();
            }
            const queryPayload = this.verifySessionJwt(req.query.token);
            if (queryPayload && queryPayload.sub) {
                req.oauthUser = { email: queryPayload.email, sub: queryPayload.sub };
                return next();
            }
            this.validateToken(req.query.token || "", (err, valid) => {
                if (valid) {
                    next();
                } else {
                    res.status(401).json({
                        error: "Invalid authentication: sign in at /login.html or pass a valid token."
                    });
                }
            });
        };
    }
};
