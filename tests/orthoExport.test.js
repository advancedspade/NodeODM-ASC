/*
NodeODM App and REST API to access ODM.
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
"use strict";

const assert = require("assert");
const {
    parseExportRequest,
    exportIsActive,
    jobResourceName,
    newExportClaim,
    buildQueuedExport,
    cadStagePrefix,
    QUEUED_STALE_MS,
    RUNNING_STALE_MS
} = require("../libs/orthoExport");
const { isDownloadableProjectRelativePath } = require("../libs/gcsProjectName");

function test(name, fn) {
    try {
        fn();
        console.log("ok - " + name);
    } catch (err) {
        console.error("fail - " + name);
        console.error(err && err.stack ? err.stack : err);
        process.exitCode = 1;
    }
}

test("defaults missing unit to centimetres", () => {
    const parsed = parseExportRequest({ gsd: 5, keepCrs: true });
    assert.strictEqual(parsed.error, undefined);
    assert.strictEqual(parsed.value.unit, "cm");
    assert.strictEqual(parsed.value.keepCrs, true);
    assert.strictEqual(parsed.value.epsg, null);
});

test("accepts US survey feet", () => {
    const parsed = parseExportRequest({ gsd: 0.15, unit: "ft (US survey)", keepCrs: true });
    assert.strictEqual(parsed.error, undefined);
    assert.ok(parsed.value.gsd * (1200 / 3937) > 0.01);
});

test("rejects reproject without an EPSG", () => {
    const parsed = parseExportRequest({ gsd: 5, unit: "cm", keepCrs: false });
    assert.ok(parsed.error);
});

test("accepts a numeric EPSG when reprojecting", () => {
    const parsed = parseExportRequest({ gsd: 5, unit: "cm", keepCrs: false, epsg: 6418 });
    assert.strictEqual(parsed.error, undefined);
    assert.strictEqual(parsed.value.epsg, 6418);
});

test("rejects a ground resolution finer than 1 cm", () => {
    const parsed = parseExportRequest({ gsd: 0.1, unit: "cm", keepCrs: true });
    assert.ok(parsed.error);
});

test("queued export stays active inside the start window", () => {
    const now = Date.now();
    assert.strictEqual(exportIsActive({
        status: "queued",
        startedAt: new Date(now - 60 * 1000).toISOString()
    }, now), true);
    assert.strictEqual(exportIsActive({
        status: "queued",
        startedAt: new Date(now - QUEUED_STALE_MS - 1000).toISOString()
    }, now), false);
});

test("running export stays active until the job timeout elapses", () => {
    const now = Date.now();
    assert.strictEqual(exportIsActive({
        status: "running",
        startedAt: new Date(now - 30 * 60 * 1000).toISOString()
    }, now), true);
    assert.strictEqual(exportIsActive({
        status: "running",
        startedAt: new Date(now - RUNNING_STALE_MS - 1000).toISOString()
    }, now), false);
    assert.strictEqual(exportIsActive({ status: "succeeded", startedAt: new Date(now).toISOString() }, now), false);
});

test("queued export carries a claim the worker must present", () => {
    const claim = newExportClaim();
    assert.match(claim, /^[0-9a-f]{32}$/);
    const queued = buildQueuedExport({ gsd: 5, unit: "cm", keepCrs: true, epsg: null }, 100, claim, "2026-09-29T00:00:00.000Z");
    assert.strictEqual(queued.status, "queued");
    assert.strictEqual(queued.claim, claim);
    assert.strictEqual(queued.execution, null);
    assert.throws(() => buildQueuedExport({}, 0, "", "2026-09-29T00:00:00.000Z"));
});

test("staged outputs live outside every project prefix", () => {
    const stage = cadStagePrefix("outputs", "Job_A", "abc");
    assert.strictEqual(stage, "outputs/.uploads/cad-export/Job_A/abc");
    assert.strictEqual(cadStagePrefix("outputs/", "Job_A", "abc"), stage);
    assert.strictEqual(cadStagePrefix("", "Job_A", "abc"), ".uploads/cad-export/Job_A/abc");
    assert.strictEqual(cadStagePrefix("outputs", "", "abc"), "");
    assert.strictEqual(cadStagePrefix("outputs", "Job_A", ""), "");
    // The project file browser never lists this subtree even if it shared a prefix.
    assert.strictEqual(isDownloadableProjectRelativePath(".uploads/cad-export/Job_A/abc/odm_orthophoto_small.tif"), false);
});

test("job resource name must be a Cloud Run jobs path", () => {
    assert.strictEqual(
        jobResourceName("projects/tools-471222/locations/us-central1/jobs/cad-ortho-export"),
        "projects/tools-471222/locations/us-central1/jobs/cad-ortho-export"
    );
    assert.strictEqual(jobResourceName("cad-ortho-export"), "");
    assert.strictEqual(jobResourceName(""), "");
});
