/*
 * Server-side forwarder for UI feedback to Shelby Cloud's public support API.
 *
 * The browser never talks to Shelby directly: Shelby's CORS allowlist does not
 * include the ODM hosts, and the ClusterODM edge only trusts same-origin calls.
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const config = require("../config");
const logger = require("./logger");

// Shelby classifies this portal with its internal/admin tooling sources.
const CLIENT_SOURCE = "tools";
const UPSTREAM_PATH = "/support/feedback/public";
const UPSTREAM_TIMEOUT_MS = 15000;
// Shelby truncates on its side; this only keeps a hostile client from making us
// buffer an unbounded body before the upstream request even starts.
const MAX_FIELD_LENGTHS = {
    email: 320,
    subject: 300,
    message: 20000,
    name: 200,
    org_name: 200,
    category: 40,
    severity: 40,
    ticketPriority: 20
};

const CATEGORIES = new Set(["bug", "feature", "improvement", "behavior"]);
const TICKET_PRIORITIES = new Set(["Critical", "High", "Medium", "Low"]);

let appVersion = "";
try {
    appVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"))).version || "";
} catch (e) {
    appVersion = "";
}

function enabled() {
    return !!config.supportApiUrl;
}

function trimmed(value, max) {
    if (typeof value !== "string") return "";
    const out = value.trim();
    return max && out.length > max ? out.slice(0, max) : out;
}

function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Only fields Shelby's public contract reads; everything else is dropped. */
function buildUpstreamBody(req) {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const authenticatedEmail = req.oauthUser && req.oauthUser.email;

    const email = trimmed(authenticatedEmail || body.email, MAX_FIELD_LENGTHS.email);
    const category = trimmed(body.category, MAX_FIELD_LENGTHS.category).toLowerCase();
    const message = trimmed(body.message, MAX_FIELD_LENGTHS.message);
    const subject = trimmed(body.subject, MAX_FIELD_LENGTHS.subject);
    const severity = trimmed(body.severity, MAX_FIELD_LENGTHS.severity).toLowerCase();
    const ticketPriority = trimmed(body.ticketPriority, MAX_FIELD_LENGTHS.ticketPriority);

    if (!email || !isEmail(email)) return { error: "A valid email address is required." };
    if (!CATEGORIES.has(category)) return { error: "Select a feedback category." };
    if (!message) return { error: "Message is required." };

    const out = {
        email,
        subject: subject || "Feedback",
        message,
        category,
        source: CLIENT_SOURCE
    };
    if (severity) out.severity = severity;
    if (TICKET_PRIORITIES.has(ticketPriority)) out.ticketPriority = ticketPriority;
    const name = trimmed(body.name, MAX_FIELD_LENGTHS.name);
    if (name) out.name = name;
    const orgName = trimmed(body.org_name, MAX_FIELD_LENGTHS.org_name);
    if (orgName) out.org_name = orgName;
    if (appVersion) out.app_version = appVersion;

    return { body: out };
}

/** Shelby rate-limits per IP, so the real client IP has to survive the hop. */
function forwardedForHeader(req) {
    const existing = req.headers["x-forwarded-for"];
    const remote = (req.socket && req.socket.remoteAddress) || "";
    if (existing) return remote ? existing + ", " + remote : existing;
    return remote;
}

function postJson(urlStr, payload, headers) {
    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(urlStr);
        } catch (e) {
            return reject(new Error("invalid SUPPORT_API_URL: " + urlStr));
        }
        const transport = u.protocol === "http:" ? http : https;
        const data = Buffer.from(JSON.stringify(payload), "utf8");
        const request = transport.request(
            {
                hostname: u.hostname,
                port: u.port || undefined,
                path: u.pathname + u.search,
                method: "POST",
                headers: Object.assign({
                    "Content-Type": "application/json",
                    "Content-Length": data.length,
                    Accept: "application/json"
                }, headers || {})
            },
            res => {
                let raw = "";
                res.setEncoding("utf8");
                res.on("data", chunk => {
                    raw += chunk;
                });
                res.on("end", () => {
                    resolve({ statusCode: res.statusCode, headers: res.headers, raw });
                });
            }
        );
        request.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
            request.destroy(new Error("timeout contacting the feedback service"));
        });
        request.on("error", reject);
        request.end(data);
    });
}

function handleFeedback(req, res) {
    if (!enabled()) {
        return res.status(503).json({ error: "Feedback is not configured on this server." });
    }

    const built = buildUpstreamBody(req);
    if (built.error) {
        return res.status(400).json({ error: built.error });
    }

    const headers = {
        "x-client-source": CLIENT_SOURCE
    };
    if (appVersion) headers["x-client-version"] = appVersion;
    const forwardedFor = forwardedForHeader(req);
    if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;
    if (req.headers["user-agent"]) headers["User-Agent"] = req.headers["user-agent"];

    postJson(config.supportApiUrl + UPSTREAM_PATH, built.body, headers).then(upstream => {
        let parsed = null;
        try {
            parsed = upstream.raw ? JSON.parse(upstream.raw) : null;
        } catch (e) {
            parsed = null;
        }

        if (upstream.statusCode === 429) {
            if (upstream.headers["retry-after"]) {
                res.setHeader("Retry-After", upstream.headers["retry-after"]);
            }
            return res.status(429).json(parsed || {
                error: "Too many feedback submissions. Please try again later."
            });
        }
        if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
            return res.status(upstream.statusCode).json(parsed || { success: true });
        }
        if (upstream.statusCode === 400 && parsed && parsed.error) {
            return res.status(400).json({ error: parsed.error });
        }

        logger.warn("Feedback upstream returned HTTP " + upstream.statusCode);
        res.status(502).json({ error: "The feedback service could not accept the submission." });
    }).catch(err => {
        logger.error("Feedback forwarding failed: " + ((err && err.message) || String(err)));
        res.status(502).json({ error: "Could not reach the feedback service. Please try again." });
    });
}

module.exports = {
    enabled,
    handleFeedback
};
