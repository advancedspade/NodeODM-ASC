/*
NodeODM App and REST API to access ODM.
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const logger = require("./logger");

const SCRIPT_PATH = path.join(__dirname, "rtk_analysis.py");

let cachedAvailability = null;

function pythonCommand() {
    const candidates = ["python3", "python"];
    for (const cmd of candidates) {
        const check = spawnSync(cmd, ["--version"], { encoding: "utf8" });
        if (check.status === 0) return cmd;
    }
    return null;
}

function exiftoolCommand() {
    const check = spawnSync("exiftool", ["-ver"], { encoding: "utf8" });
    if (check.status === 0) return "exiftool";
    return null;
}

function getStatus() {
    if (cachedAvailability) return cachedAvailability;

    const python = pythonCommand();
    const exiftool = exiftoolCommand();
    const available = !!(python && exiftool && fs.existsSync(SCRIPT_PATH));

    let reason = "";
    if (!python) reason = "python3 is not available";
    else if (!exiftool) reason = "exiftool is not on PATH (install libimage-exiftool-perl)";
    else if (!fs.existsSync(SCRIPT_PATH)) reason = "rtk_analysis.py is missing";
    else reason = "ready";

    cachedAvailability = {
        available,
        python: python || null,
        exiftool: exiftool || null,
        reason
    };
    return cachedAvailability;
}

function isAvailable() {
    return getStatus().available;
}

function readJsonFile(filePath, cb) {
    fs.readFile(filePath, "utf8", (err, data) => {
        if (err) return cb(err);
        try {
            cb(null, JSON.parse(data));
        } catch (e) {
            cb(new Error(`Invalid JSON in ${filePath}: ${e.message}`));
        }
    });
}

/**
 * Run RTK analysis on a folder of images.
 * @param {string} imagesDir - folder containing image files
 * @param {string} outputDir - folder where rtk_analysis.* files are written
 * @param {function} cb - (err, { summary, records, reportText, outputDir })
 */
function runAnalysis(imagesDir, outputDir, cb) {
    const status = getStatus();
    if (!status.available) {
        return cb(new Error(status.reason || "RTK analysis is not available"));
    }

    const imagesAbs = path.resolve(imagesDir);
    const outputAbs = path.resolve(outputDir);

    fs.mkdir(outputAbs, { recursive: true }, mkdirErr => {
        if (mkdirErr) return cb(mkdirErr);

        const args = [
            SCRIPT_PATH,
            imagesAbs,
            "--output-dir",
            outputAbs
        ];

        logger.info(`RTK analysis: ${status.python} ${args.join(" ")}`);

        const child = spawn(status.python, args, {
            cwd: path.dirname(SCRIPT_PATH),
            env: process.env
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk.toString(); });
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });

        child.on("error", err => cb(err));

        child.on("close", code => {
            if (code !== 0) {
                const msg = (stderr || stdout || `exit code ${code}`).trim();
                return cb(new Error(msg || `RTK analysis failed (${code})`));
            }

            const summaryPath = path.join(outputAbs, "rtk_summary.json");
            const reportPath = path.join(outputAbs, "rtk_analysis.txt");

            readJsonFile(summaryPath, (summaryErr, summary) => {
                if (summaryErr) return cb(summaryErr);

                fs.readFile(reportPath, "utf8", (reportErr, reportText) => {
                    if (reportErr) reportText = stdout;

                    const records = (summary && Array.isArray(summary.records))
                        ? summary.records
                        : [];

                    cb(null, {
                        summary,
                        records,
                        reportText,
                        outputDir,
                        stdout: stdout.trim()
                    });
                });
            });
        });
    });
}

/** Invalidate cached tool detection (e.g. after install in dev). */
function resetCache() {
    cachedAvailability = null;
}

module.exports = {
    getStatus,
    isAvailable,
    runAnalysis,
    resetCache
};
