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

module.exports = {
    sanitizeProjectName,
    gcsDestPathForProject
};
