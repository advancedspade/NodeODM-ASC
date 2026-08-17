/*
NodeODM App and REST API to access ODM.
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
"use strict";

/** Same rules as Task.js post-process GCS folder names. */
function sanitizeProjectName(name, fallback) {
    const sanitized = String(name || "")
        .trim()
        .replace(/[^a-zA-Z0-9_\-\s]/g, "")
        .replace(/\s+/g, "_")
        .substring(0, 100);
    return sanitized || fallback || "";
}

function gcsDestPathForProject(sanitizedName, uploadPrefix) {
    if (!sanitizedName) return "";
    const prefix = (uploadPrefix || "").replace(/\/$/, "");
    return prefix ? `${prefix}/${sanitizedName}` : sanitizedName;
}

/**
 * Object names are arbitrary strings, so a key under a project prefix can still
 * carry ".." or empty segments. Such a path must never reach a ZIP entry name
 * (zip slip) or a client-side file list.
 */
function isSafeProjectRelativePath(rel) {
    const path = String(rel || "");
    if (!path || path.includes("\\")) return false;
    return path.split("/").every(seg => seg && seg !== "." && seg !== "..");
}

/** Paths omitted from listProjectFiles — download/archive must match. */
function isDownloadableProjectRelativePath(rel) {
    const path = String(rel || "");
    if (!isSafeProjectRelativePath(path)) return false;
    if (path === ".uploads" || path.startsWith(".uploads/")) return false;
    if (path === "all.zip") return false;
    if (path === "opensfm" || path.startsWith("opensfm/")) return false;
    return true;
}

module.exports = {
    sanitizeProjectName,
    gcsDestPathForProject,
    isSafeProjectRelativePath,
    isDownloadableProjectRelativePath
};
