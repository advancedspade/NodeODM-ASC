/*
NodeODM App and REST API to access ODM.
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
"use strict";

const TILEMAP_REL = "orthophoto_tiles/tilemapresource.xml";

function attr(tag, name, xml) {
    const re = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`, "i");
    const m = String(xml || "").match(re);
    return m ? m[1] : null;
}

function parseFloatSafe(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

/** Web Mercator meters → approximate WGS84 degrees (same linear approx as shelby-cloud). */
function mercatorMetersToDegrees(meters) {
    return meters * 180 / (Math.PI * 6378137);
}

/**
 * Normalize TMS BoundingBox to Leaflet/Mapbox [west, south, east, north] in WGS84.
 * Handles Web Mercator meters and the lat/lon axis swap sometimes seen in gdal2tiles XML.
 */
function normalizeBounds(minx, miny, maxx, maxy) {
    let west = minx;
    let south = miny;
    let east = maxx;
    let north = maxy;

    // Web Mercator meters are typically |n| >> 180. Degree values that merely
    // swamp the lat range (axis-swapped lon in the "south" slot) must not be
    // treated as meters.
    const looksLikeMeters =
        Math.abs(west) > 200 || Math.abs(south) > 200 ||
        Math.abs(east) > 200 || Math.abs(north) > 200;
    if (looksLikeMeters) {
        west = mercatorMetersToDegrees(west);
        south = mercatorMetersToDegrees(south);
        east = mercatorMetersToDegrees(east);
        north = mercatorMetersToDegrees(north);
    }

    // Some gdal2tiles outputs put latitude in minx/maxx and longitude in miny/maxy.
    if (Math.abs(south) > 90 || Math.abs(north) > 90) {
        const swapped = [south, west, north, east];
        west = swapped[0];
        south = swapped[1];
        east = swapped[2];
        north = swapped[3];
    }

    if (!(west < east && south < north)) return null;
    if (west < -180 || east > 180 || south < -90 || north > 90) return null;
    return [west, south, east, north];
}

/**
 * Parse ODM/gdal2tiles tilemapresource.xml into preview metadata.
 * @returns {{ title: string, bounds: number[], minZoom: number, maxZoom: number, scheme: string }|null}
 */
function parseTilemapResourceXml(xml) {
    const text = String(xml || "");
    if (!text.trim()) return null;

    const minx = parseFloatSafe(attr("BoundingBox", "minx", text));
    const miny = parseFloatSafe(attr("BoundingBox", "miny", text));
    const maxx = parseFloatSafe(attr("BoundingBox", "maxx", text));
    const maxy = parseFloatSafe(attr("BoundingBox", "maxy", text));
    if (minx == null || miny == null || maxx == null || maxy == null) return null;

    const bounds = normalizeBounds(minx, miny, maxx, maxy);
    if (!bounds) return null;

    const zooms = [];
    const tileSetRe = /<TileSet\b[^>]*\bhref="(\d+)"/gi;
    let m;
    while ((m = tileSetRe.exec(text)) !== null) {
        const z = parseInt(m[1], 10);
        if (Number.isFinite(z)) zooms.push(z);
    }
    if (!zooms.length) return null;

    const titleMatch = text.match(/<Title>([^<]*)<\/Title>/i);
    return {
        title: titleMatch ? titleMatch[1].trim() : "Orthophoto",
        bounds,
        minZoom: Math.min.apply(null, zooms),
        maxZoom: Math.max.apply(null, zooms),
        scheme: "tms"
    };
}

/**
 * Validate TMS tile coordinates and return the project-relative PNG path, or null.
 */
function orthophotoTileRelativePath(z, x, y) {
    const zi = parseInt(z, 10);
    const xi = parseInt(x, 10);
    const yi = parseInt(y, 10);
    if (!Number.isFinite(zi) || !Number.isFinite(xi) || !Number.isFinite(yi)) return null;
    if (zi < 0 || zi > 30 || xi < 0 || yi < 0) return null;
    const maxIndex = Math.pow(2, zi) - 1;
    if (xi > maxIndex || yi > maxIndex) return null;
    if (String(z) !== String(zi) || String(x) !== String(xi) || String(y) !== String(yi)) return null;
    return `orthophoto_tiles/${zi}/${xi}/${yi}.png`;
}

module.exports = {
    TILEMAP_REL,
    parseTilemapResourceXml,
    orthophotoTileRelativePath,
    normalizeBounds,
    mercatorMetersToDegrees
};
