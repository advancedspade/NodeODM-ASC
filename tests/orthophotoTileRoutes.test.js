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
const Module = require("module");
const path = require("path");
const fs = require("fs");
const { Readable } = require("stream");

const fixtureXml = fs.readFileSync(
    path.join(__dirname, "processing_results", "orthophoto_tiles", "tilemapresource.xml"),
    "utf8"
);

function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === "function") {
            return result.then(() => console.log("ok - " + name)).catch(err => {
                console.error("fail - " + name);
                console.error(err && err.stack ? err.stack : err);
                process.exitCode = 1;
            });
        }
        console.log("ok - " + name);
    } catch (err) {
        console.error("fail - " + name);
        console.error(err && err.stack ? err.stack : err);
        process.exitCode = 1;
    }
    return Promise.resolve();
}

function loadGcsUploadApiWithMocks(gcsMock) {
    const apiPath = require.resolve("../libs/gcsUploadApi");
    const gcsPath = require.resolve("../libs/GCS");
    const loggerPath = require.resolve("../libs/logger");
    delete require.cache[apiPath];
    delete require.cache[gcsPath];

    const stubs = {
        [gcsPath]: gcsMock,
        [loggerPath]: {
            info() {},
            warn() {},
            error() {},
            debug() {}
        }
    };

    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        try {
            const resolved = originalLoad === Module._load
                ? null
                : null;
            // Resolve relative stubs from the requesting parent.
            if (parent && parent.filename && request.startsWith(".")) {
                const abs = require.resolve(request, { paths: [path.dirname(parent.filename)] });
                if (stubs[abs]) return stubs[abs];
            }
        } catch (e) { /* fall through */ }
        if (stubs[request]) return stubs[request];
        return originalLoad(request, parent, isMain);
    };

    try {
        return require("../libs/gcsUploadApi");
    } finally {
        Module._load = originalLoad;
    }
}

function mockRes() {
    const headers = {};
    const res = {
        statusCode: 200,
        headers,
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        status(code) { res.statusCode = code; return res; },
        json(body) { res.body = body; return res; },
        end() { return res; },
        destroy() {},
        on() { return res; },
        once() { return res; },
        emit() { return false; },
        write() { return true; }
    };
    return res;
}

async function run() {
    await test("handleOrthophotoTile streams PNG without attachment disposition", () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const stream = Readable.from([png]);
        const req = { params: { projectName: "Demo_Project", z: "16", x: "1", y: "2" } };
        const res = mockRes();
        let piped = false;
        stream.pipe = function(dest) {
            piped = true;
            assert.strictEqual(dest, res);
            return dest;
        };
        const api = loadGcsUploadApiWithMocks({
            enabled: () => true,
            getObjectMetadata: (_objectPath, cb) => cb(null, { size: png.length, contentType: "image/png" }),
            createReadStream: () => stream,
            contentTypeForPath: () => "image/png"
        });
        api.handleOrthophotoTile(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers["content-type"], "image/png");
        assert.strictEqual(res.headers["cache-control"], "private, max-age=3600");
        assert.ok(!Object.prototype.hasOwnProperty.call(res.headers, "content-disposition"));
        assert.ok(piped);
    });

    await test("handleOrthophotoTile rejects invalid coordinates", () => {
        const api = loadGcsUploadApiWithMocks({
            enabled: () => true,
            getObjectMetadata: () => assert.fail("should not touch GCS"),
            createReadStream: () => assert.fail("should not touch GCS")
        });
        const req = { params: { projectName: "Demo_Project", z: "xx", x: "1", y: "2" } };
        const res = mockRes();
        api.handleOrthophotoTile(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.body && /Invalid tile/i.test(res.body.error));
    });

    await test("handleOrthophotoTilesInfo parses tilemap XML", () => new Promise((resolve, reject) => {
        const stream = Readable.from([Buffer.from(fixtureXml, "utf8")]);
        const api = loadGcsUploadApiWithMocks({
            enabled: () => true,
            createReadStream: () => stream
        });
        const req = { params: { projectName: "Demo_Project" } };
        const res = mockRes();
        res.json = function(body) {
            try {
                assert.ok(body.bounds);
                assert.strictEqual(body.scheme, "tms");
                assert.strictEqual(body.minZoom, 16);
                assert.strictEqual(body.maxZoom, 18);
                assert.ok(body.tileUrlTemplate.indexOf("/orthophoto-tiles/") >= 0);
                assert.strictEqual(res.headers["cache-control"], "private, max-age=60");
                resolve();
            } catch (err) {
                reject(err);
            }
            return res;
        };
        api.handleOrthophotoTilesInfo(req, res);
        setTimeout(() => reject(new Error("info handler timed out")), 1000);
    }));

    if (!process.exitCode) {
        console.log("All orthophoto tile route tests passed.");
    }
}

run().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
