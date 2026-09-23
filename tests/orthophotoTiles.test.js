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
const fs = require("fs");
const path = require("path");
const {
    parseTilemapResourceXml,
    orthophotoTileRelativePath,
    normalizeBounds,
    TILEMAP_REL
} = require("../libs/orthophotoTiles");
const { isDownloadableProjectRelativePath, gcsDestPathForProject } = require("../libs/gcsProjectName");

const fixtureXml = fs.readFileSync(
    path.join(__dirname, "processing_results", "orthophoto_tiles", "tilemapresource.xml"),
    "utf8"
);

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

test("TILEMAP_REL constant", () => {
    assert.strictEqual(TILEMAP_REL, "orthophoto_tiles/tilemapresource.xml");
});

test("parse fixture tilemapresource.xml", () => {
    const meta = parseTilemapResourceXml(fixtureXml);
    assert.ok(meta);
    assert.strictEqual(meta.scheme, "tms");
    assert.strictEqual(meta.minZoom, 16);
    assert.strictEqual(meta.maxZoom, 18);
    assert.ok(Array.isArray(meta.bounds));
    assert.strictEqual(meta.bounds.length, 4);
    const [west, south, east, north] = meta.bounds;
    // Fixture stores lat in minx/maxx and lon in miny/maxy — parser should swap.
    assert.ok(west < east);
    assert.ok(south < north);
    assert.ok(west < -90 && west > -92, "west should be longitude near Duluth");
    assert.ok(south > 46 && south < 47, "south should be latitude near Duluth");
});

test("parse rejects empty xml", () => {
    assert.strictEqual(parseTilemapResourceXml(""), null);
    assert.strictEqual(parseTilemapResourceXml("<TileMap></TileMap>"), null);
});

test("normalizeBounds converts mercator meters", () => {
    const meters = [-10236528.0, 5699988.0, -10236000.0, 5700500.0];
    const bounds = normalizeBounds(meters[0], meters[1], meters[2], meters[3]);
    assert.ok(bounds);
    assert.ok(bounds[0] < bounds[2]);
    assert.ok(bounds[1] < bounds[3]);
    assert.ok(Math.abs(bounds[0]) <= 180);
    assert.ok(Math.abs(bounds[1]) <= 90);
});

test("orthophotoTileRelativePath validates coordinates", () => {
    assert.strictEqual(orthophotoTileRelativePath(16, 0, 0), "orthophoto_tiles/16/0/0.png");
    assert.strictEqual(orthophotoTileRelativePath("18", "3", "7"), "orthophoto_tiles/18/3/7.png");
    assert.strictEqual(orthophotoTileRelativePath(-1, 0, 0), null);
    assert.strictEqual(orthophotoTileRelativePath(2, 4, 0), null); // x out of range for z=2
    assert.strictEqual(orthophotoTileRelativePath("01", 0, 0), null); // reject padded strings
    assert.strictEqual(orthophotoTileRelativePath("abc", 0, 0), null);
});

test("tile paths are downloadable / safe under project prefix", () => {
    assert.ok(isDownloadableProjectRelativePath("orthophoto_tiles/16/0/0.png"));
    assert.ok(isDownloadableProjectRelativePath(TILEMAP_REL));
    assert.ok(!isDownloadableProjectRelativePath("orthophoto_tiles/../secrets.png"));
    const dest = gcsDestPathForProject("My_Project", "outputs");
    assert.strictEqual(dest, "outputs/My_Project");
    assert.strictEqual(
        dest + "/" + orthophotoTileRelativePath(16, 1, 2),
        "outputs/My_Project/orthophoto_tiles/16/1/2.png"
    );
});

test("bootstrap maps payload shape (config)", () => {
    // Ensure config exports the field without requiring MAPBOX to be set.
    const config = require("../config");
    assert.strictEqual(typeof config.mapboxAccessToken, "string");
});

if (!process.exitCode) {
    console.log("All orthophotoTiles tests passed.");
}
