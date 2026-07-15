/* 
NodeODM App and REST API to access ODM. 
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
"use strict";
const odmRunner = require('./odmRunner');
const config = require('../config');
const { OPTION_UI_DEFAULTS, applyUiDefaultsToOptions } = require('./odmUiDefaults');
const async = require('async');
const assert = require('assert');
const logger = require('./logger');

let odmOptions = null;
let odmVersion = null;
let engine = null;

function parseMemoryLimitToGB(raw) {
    if (!raw) return null;
    const s = String(raw).trim().toLowerCase();
    const m = s.match(/^(\d+(?:\.\d+)?)\s*([gmk])?b?$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = m[2] || "g";
    if (unit === "m") return n / 1024;
    if (unit === "k") return n / (1024 * 1024);
    return n;
}

/** RAM visible to this process (respect Docker/Podman cgroup limits when set). */
function getVisibleMemoryGB() {
    const fs = require("fs");
    const nodeOs = require("os");
    let totalGB = nodeOs.totalmem() / (1024 * 1024 * 1024);

    const cgroupPaths = [
        "/sys/fs/cgroup/memory.max",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes"
    ];
    for (let i = 0; i < cgroupPaths.length; i++) {
        try {
            if (!fs.existsSync(cgroupPaths[i])) continue;
            const raw = fs.readFileSync(cgroupPaths[i], "utf8").trim();
            if (raw === "max") continue;
            const bytes = parseInt(raw, 10);
            if (Number.isFinite(bytes) && bytes > 0) {
                const limitGB = bytes / (1024 * 1024 * 1024);
                if (limitGB > 0 && limitGB < totalGB) totalGB = limitGB;
            }
        } catch (e) { /* ignore */ }
    }

    const configured = parseMemoryLimitToGB(config.dockerMemoryLimit);
    if (configured && configured > 0 && configured < totalGB) {
        totalGB = configured;
    }

    return totalGB;
}

module.exports = {
    initialize: function(done){
        async.parallel([
            this.getOptions,
            this.getVersion
        ], done);
    },
    
    getVersion: function(done){
        if (odmVersion){
            done(null, odmVersion);
            return;
        }

        odmRunner.getVersion((err, version) => {
            odmVersion = version;
            done(null, version);
        });
    },

    getEngine: function(done){
        if (engine){
            done(null, engine);
            return;
        }

        odmRunner.getEngine((err, eng) => {
            engine = eng;
            done(null, eng);
        });
    },

    supportsOption: function(optName, cb){
        this.getOptions((err, json) => {
            if (err) cb(err);
            else{
                cb(null, !!json.find(opt => opt.name === optName));
            }
        });
    },

    getOptions: function(done){
        if (odmOptions){
            applyUiDefaultsToOptions(odmOptions);
            done(null, odmOptions);
            return;
        }

        odmRunner.getJsonOptions((err, json) => {
            if (err) done(err);
            else{
                odmOptions = [];
                for (let option in json){
                    // Not all options are useful to the end user
                    // (num cores can be set programmatically, so can gcpFile, etc.)
                    if (["-h", "--project-path", "--cmvs-maxImages", "--time",
                        "--zip-results", "--pmvs-num-cores",
                        "--start-with", "--gcp", "--images", "--geo", "--align",
                        "--split-image-groups", "--copy-to",
                        "--rerun-all", "--rerun",
                        "--slam-config", "--video", "--version", "name"].indexOf(option) !== -1) continue;

                    let values = json[option];

                    let name = option.replace(/^--/, "");
                    let type = "";
                    let value = "";
                    let help = values.help || "";
                    let domain = values.metavar !== undefined ? 
                                 values.metavar.replace(/^[<>]/g, "")
                                                .replace(/[<>]$/g, "")
                                                .trim() : 
                                 "";

                    switch((values.type || "").trim()){
                        case "<type 'int'>":
                        case "<class 'int'>":
                            type = "int";
                            value = values['default'] !== undefined ? 
                                            parseInt(values['default']) :
                                            0;
                            break;
                        case "<type 'float'>":
                        case "<class 'float'>":
                            type = "float";
                            value = values['default'] !== undefined ? 
                                            parseFloat(values['default']) :
                                            0.0;
                            break;
                        default:
                            type = "string";
                            value = values['default'] !== undefined ? 
                                    values['default'].trim() :
                                    "";
                    }

                    if (values['default'] === "True"){
                        type = "bool";
                        value = true;
                    }else if (values['default'] === "False"){
                        type = "bool";
                        value = false;
                    }

                    // If 'choices' is specified, try to convert it to array
                    if (values.choices){
                        try{
                            values.choices = JSON.parse(values.choices.replace(/'/g, '"')); // Convert ' to "
                        }catch(e){
                            logger.warn(`Cannot parse choices: ${values.choices}`);
                        }	
                    }

                    // In the end, all values must be converted back
                    // to strings (per OpenAPI spec which doesn't allow mixed types)
                    value = String(value);

                    if (Array.isArray(values.choices)){
                        type = "enum";
                        domain = values.choices;

                        // Make sure that the default value
                        // is in the list of choices
                        if (domain.indexOf(value) === -1) domain.unshift(value);
                    }
                    
                    odmOptions.push({
                        name, type, value, domain, help
                    });
                }

                applyUiDefaultsToOptions(odmOptions);

                done(null, odmOptions);
            }
        });
    },

    // Checks that the options (as received from the rest endpoint)
    // Are valid and within proper ranges.
    // The result of filtering is passed back via callback
    // @param options[]
    filterOptions: function(options, done){
        assert(odmOptions !== null, "odmOptions is not set. Have you initialized odmOptions properly?");

        try{
            if (typeof options === "string") options = JSON.parse(options);
            if (!Array.isArray(options)) options = [];

            const normOptName = name => {
                if (name == null || name === "") return "";
                return String(name).replace(/^--+/, "").trim().toLowerCase();
            };
            const emptyish = v => {
                if (v == null) return true;
                if (typeof v === "string") return v.trim() === "";
                if (Array.isArray(v)) return v.length === 0;
                if (typeof v === "object") return Object.keys(v).length === 0;
                return false;
            };
            const optionalPathOrJsonByName = n => {
                const x = normOptName(n);
                return x === "cameras" || x === "boundary";
            };
            const domainLooksJsonLike = domain => typeof domain === "string" && /json/i.test(domain.trim());

            // Drop unset optional path/json fields (ClusterODM / WebODM sometimes send {}, odd casing, or "--name")
            options = options.filter(o => {
                if (!o || o.name == null) return true;
                if (optionalPathOrJsonByName(o.name) && emptyish(o.value)) return false;
                return true;
            });

            let result = [];
            let errors = [];
            let addError = function(opt, descr){
                errors.push({
                    name: opt.name,
                    error: descr
                });
            };

            let typeConversion = {
                'float': Number.parseFloat,
                'int': Number.parseInt,
                'bool': function(value){
                    if (value === 'true' || value === '1') return true;
                    else if (value === 'false' || value === '0') return false;
                    else if (typeof value === 'boolean') return value;
                    else throw new Error(`Cannot convert ${value} to boolean`);
                },
                'string': function(value){
                    return value; // No conversion needed
                },
                'path': function(value){
                    return value; // No conversion needed
                },
                'enum': function(value){
                    return value; // No conversion needed
                }
            };
            
            let domainChecks = [
                {
                    regex: /^(positive |negative )?(integer|float)$/, 
                    validate: function(matches, value){
                        if (matches[1] === 'positive ') return value >= 0;
                        else if (matches[1] === 'negative ') return value <= 0;
                        
                        else if (matches[2] === 'integer') return Number.isInteger(value);
                        else if (matches[2] === 'float') return Number.isFinite(value);
                    }
                },
                {
                    regex: /^percent$/,
                    validate: function(matches, value){
                        return value >= 0 && value <= 100;
                    }
                },
                {
                    regex: /^(float|integer): ([\-\+\.\d]+) <= x <= ([\-\+\.\d]+)$/,
                    validate: function(matches, value){
                        let [str, type, lower, upper] = matches;
                        let parseFunc = type === 'float' ? parseFloat : parseInt;
                        lower = parseFunc(lower);
                        upper = parseFunc(upper);
                        return value >= lower && value <= upper;						
                    }
                },
                {
                    regex: /^(float|integer) (>=|>|<|<=) ([\-\+\.\d]+)$/,
                    validate: function(matches, value){
                        let [str, type, oper, bound] = matches;
                        let parseFunc = type === 'float' ? parseFloat : parseInt;
                        bound = parseFunc(bound);
                        switch(oper){
                            case '>=':
                                return value >= bound;
                            case '>':
                                return value > bound;
                            case '<=':
                                return value <= bound;
                            case '<':
                                return value < bound;
                            default:
                                return false;
                        }
                    }
                },
                {
                    regex: /^(json|path or json|path_or_json)$/i,
                    validate: function(matches, value){
                        const t = value == null ? "" : String(value).trim();
                        if (t === "") return true;
                        try {
                            JSON.parse(t);
                            return true;
                        } catch (e) {
                            // ODM --cameras / --boundary accept a file path or inline JSON
                            return t.length > 0;
                        }
                    }
                },
                {
                    regex: /^(string|path)$/,
                    validate: function(){
                        return true; // All strings/paths are fine
                    }
                }
            ];

            let checkDomain = function(domain, value){
                if (Array.isArray(domain)){
                    // Special case for enum checks
                    if (domain.indexOf(value) === -1) throw new Error(`Invalid value ${value} (not in enum)`);
                }else{
                    let matches,
                        dc = domainChecks.find(dc => matches = domain.match(dc.regex));

                    if (dc){
                        if (!dc.validate(matches, value)) throw new Error(`Invalid value ${value} (out of range)`);
                    }else{
                        throw new Error(`Domain value cannot be handled: '${domain}' : '${value}'`);
                    }
                }
            };

            // Scan through all possible options
            let maxConcurrencyFound = false;
            let maxConcurrencyIsAnOption = false;

            for (let odmOption of odmOptions){
                if (odmOption.name === 'max-concurrency') maxConcurrencyIsAnOption = true;
                
                // Was this option selected by the user?
                /*jshint loopfunc: true */
                let opt = options.find(o => o && normOptName(o.name) === normOptName(odmOption.name));
                if (opt){
                    // --cameras / --boundary: ODM exposes inconsistent type/domain across releases.
                    // Never run filterOptions checkDomain/typeConversion here — ODM validates the flag.
                    if (optionalPathOrJsonByName(odmOption.name)) {
                        if (emptyish(opt.value)) continue;
                        let v = opt.value;
                        if (v != null && typeof v === "object") {
                            try {
                                v = JSON.stringify(v);
                            } catch (e) {
                                v = String(v);
                            }
                        } else {
                            v = String(v == null ? "" : v);
                        }
                        v = v.trim();
                        if (v === "") continue;
                        result.push({ name: odmOption.name, value: v });
                        continue;
                    }

                    const domainIsJsonLike = domainLooksJsonLike(odmOption.domain);
                    try{
                        if (domainIsJsonLike && emptyish(opt.value)) {
                            continue;
                        }

                        const conv = typeConversion[odmOption.type] || typeConversion.string;
                        let value = conv(opt.value);

                        // Other optional JSON/path fields: coerce objects from JSON bodies
                        if (domainIsJsonLike) {
                            if (value != null && typeof value === "object") {
                                try {
                                    value = JSON.stringify(value);
                                } catch (e) {
                                    value = String(value);
                                }
                            }
                            const s = value == null ? "" : String(value).trim();
                            if (s === "") continue;
                            value = s;
                        }

                        // Domain check
                        if (odmOption.domain){
                            checkDomain(odmOption.domain, value);
                        }
                        
                        // Max concurrency check
                        if (normOptName(opt.name) === "max-concurrency"){
                            maxConcurrencyFound = true;

                            // Cap
                            if (config.maxConcurrency){
                                value = Math.min(value, config.maxConcurrency);
                            }
                        }

                        result.push({
                            name: odmOption.name,
                            value: value
                        });
                    }catch(e){
                        if (domainIsJsonLike && emptyish(opt.value)) {
                            continue;
                        }
                        addError(opt, e.message);
                    }
                }
            }

            let applyDefaultIfMissing = function(name){
                if (result.find(r => r.name === name)) return;
                const odmOption = odmOptions.find(o => o.name === name);
                if (!odmOption || !Object.prototype.hasOwnProperty.call(OPTION_UI_DEFAULTS, name)) return;
                try {
                    let conv = typeConversion[odmOption.type](OPTION_UI_DEFAULTS[name]);
                    if (odmOption.domain) checkDomain(odmOption.domain, conv);
                    result.push({ name: odmOption.name, value: conv });
                } catch (e) {
                    logger.warn(`Cannot apply UI default for ${name}: ${e.message}`);
                }
            };

            // So max-concurrency auto-calc sees the same resolution as later defaults
            applyDefaultIfMissing("orthophoto-resolution");

            const totalMemoryGB = getVisibleMemoryGB();
            const orthophotoResolution = result.find(r => r.name === 'orthophoto-resolution');
            const resolution = orthophotoResolution ? parseFloat(orthophotoResolution.value) : 5.0;
            const memoryPerThreadGB = resolution <= 0.2 ? 3.0 : 1.5;
            const systemReserveGB = resolution <= 0.2 ? 4.5 : 2.5;
            const availableMemoryGB = Math.max(0.5, totalMemoryGB - systemReserveGB);
            const safeConcurrencyCap = Math.max(1, Math.floor(availableMemoryGB / memoryPerThreadGB));

            if (!maxConcurrencyFound && maxConcurrencyIsAnOption) {
                let calculatedMaxConcurrency = safeConcurrencyCap;
                if (config.maxConcurrency && config.maxConcurrency > 0) {
                    calculatedMaxConcurrency = Math.min(config.maxConcurrency, safeConcurrencyCap);
                }
                result.push({
                    name: "max-concurrency",
                    value: calculatedMaxConcurrency
                });
                logger.info(`max-concurrency: ${calculatedMaxConcurrency} (cap ${safeConcurrencyCap}, ortho ${resolution} cm/px, ~${totalMemoryGB.toFixed(1)}GB visible to Node — UI default "8" is not applied unless you send it)`);
            } else if (maxConcurrencyFound && config.maxConcurrency && config.maxConcurrency > 0) {
                const maxConcurrencyOption = result.find(r => r.name === 'max-concurrency');
                if (maxConcurrencyOption) {
                    maxConcurrencyOption.value = Math.min(
                        maxConcurrencyOption.value,
                        config.maxConcurrency,
                        safeConcurrencyCap
                    );
                }
            }

            const maxConcurrencyOption = result.find(r => r.name === 'max-concurrency');
            if (maxConcurrencyOption && maxConcurrencyIsAnOption) {
                const before = Number(maxConcurrencyOption.value);
                if (!Number.isFinite(before)) {
                    maxConcurrencyOption.value = safeConcurrencyCap;
                } else {
                    const capped = Math.max(1, Math.min(Math.floor(before), safeConcurrencyCap));
                    if (capped < before) {
                        logger.info(`max-concurrency capped ${before} → ${capped} (safe for ~${totalMemoryGB.toFixed(1)}GB, ${resolution} cm/px orthophoto)`);
                    }
                    maxConcurrencyOption.value = capped;
                }
            }

            for (const name of Object.keys(OPTION_UI_DEFAULTS)) {
                if (name === "orthophoto-resolution") continue;
                if (name === "max-concurrency") continue;
                if (result.find(r => r.name === name)) continue;
                const odmOption = odmOptions.find(o => o.name === name);
                if (!odmOption) continue;
                try {
                    let conv = typeConversion[odmOption.type](OPTION_UI_DEFAULTS[name]);
                    if (odmOption.domain) {
                        checkDomain(odmOption.domain, conv);
                    }
                    result.push({
                        name: odmOption.name,
                        value: conv
                    });
                } catch (e) {
                    logger.warn(`Cannot apply UI default for ${name}: ${e.message}`);
                }
            }

            if (errors.length > 0) done(new Error(JSON.stringify(errors)));
            else done(null, result);
        }catch(e){
            done(e);
        }
    }
};