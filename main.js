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
$(function() {
    if ( window.location !== window.parent.location ) {
        // The page is in an iframe, broadcast height
        setInterval(function() {
            window.parent.postMessage(document.body.scrollHeight, "*");
        }, 200); 
    }

    function App(){
        this.mode = ko.observable("file");
        this.filesCount = ko.observable(0);
        this.error = ko.observable("");
        this.uploading = ko.observable(false);
        this.uuid = ko.observable("");
        this.uploadedFiles = ko.observable(0);
        this.fileUploadStatus = new ko.observableDictionary({});
        this.uploadedPercentage = ko.pureComputed(function(){
            return ((this.uploadedFiles() / this.filesCount()) * 100.0) + "%";
        }, this);
    }
    App.prototype.toggleMode = function(){
        if (this.mode() === 'file') this.mode('url');
        else this.mode('file');
    };
    App.prototype.dismissError = function(){
        this.error("");
    };
    App.prototype.resetUpload = function(){
        this.filesCount(0);
        this.error("");
        this.uploading(false);
        this.uuid("");
        this.uploadedFiles(0);
        this.fileUploadStatus.removeAll();
        dz.removeAllFiles(true);
    };
    App.prototype.startTask = function(){
        var self = this;
        this.uploading(true);
        this.error("");
        this.uuid("");

        var die = function(err){
            self.error(err);
            self.uploading(false);
        };

        // Start upload
        var formData = new FormData();
        formData.append("name", $("#taskName").val());
        formData.append("webhook", $("#webhook").val());
        formData.append("skipPostProcessing", !$("#doPostProcessing").prop('checked'));
        formData.append("options", JSON.stringify(buildTaskOptions()));
        // formData.append("outputs", JSON.stringify(['odm_orthophoto/odm_orthophoto.tif']));

        if (this.mode() === 'file'){
            if (this.filesCount() > 0){
                $.ajax("/task/new/init?token=" + token, {
                    type: "POST",
                    data: formData,
                    processData: false,
                    contentType: false
                }).done(function(result){
                    if (result.uuid){
                        self.uuid(result.uuid);
                        dz.processQueue();
                    }else{
                        die(result.error || result);
                    }
                }).fail(function(){
                    die("Cannot start task. Is the server available and are you connected to the internet?");
                });
            }else{
                die("No files selected");
            }
        } else if (this.mode() === 'url'){
            this.uploading(true);
            formData.append("zipurl", $("#zipurl").val());

            $.ajax("/task/new?token=" + token, {
                type: "POST",
                data: formData,
                processData: false,
                contentType: false
            }).done(function(json){
                if (json.uuid){
                    taskList.add(new Task(json.uuid));
                    self.resetUpload();
                }else{
                    die(json.error || result);
                }
            }).fail(function(){
                die("Cannot start task. Is the server available and are you connected to the internet?");
            });
        }
    }

    Dropzone.autoDiscover = false;

    var dz = new Dropzone("div#images", {
        paramName: function(){ return "images"; },
        url : "/task/new/upload/",
        parallelUploads: 8, // http://blog.olamisan.com/max-parallel-http-connections-in-a-browser max parallel connections
        uploadMultiple: false,
        acceptedFiles: "image/*,text/*,application/*,.las,.laz,video/*,.srt",
        autoProcessQueue: false,
        createImageThumbnails: false,
        previewTemplate: '<div style="display:none"></div>',
        clickable: true,
        dictDefaultMessage: "Drop files here or click to browse<br><span class=\"dz-hint\">Images, GCP, or other supported inputs.</span>",
        chunkSize: 2147483647,
        timeout: 2147483647
    });

    var DEFAULT_GPS_VIEW = { center: [20, 0], zoom: 2 };
    var ndmGpsMap = null;
    var ndmGpsMarkers = null;
    var gpsMapTimer = null;
    /** Blob URLs for map popup previews; revoked when markers refresh */
    var ndmGpsPreviewUrls = [];

    function revokeNdmGpsPreviewUrls() {
        ndmGpsPreviewUrls.forEach(function(u) {
            try {
                URL.revokeObjectURL(u);
            } catch (e) { /* ignore */ }
        });
        ndmGpsPreviewUrls = [];
    }

    /** Formats usually displayable in &lt;img&gt; (avoid broken icons for TIFF/HEIC in most browsers) */
    function ndmFileLikelyDisplayableInImgTag(file) {
        if (!file) return false;
        var t = (file.type || "").toLowerCase();
        if (t.indexOf("image/jpeg") === 0 || t.indexOf("image/jpg") === 0) return true;
        if (t === "image/png" || t === "image/webp" || t === "image/gif" || t === "image/avif") return true;
        return /\.(jpe?g|png|gif|webp|avif)$/i.test(file.name);
    }

    function setMapGpsStatus(text, loading) {
        var el = document.getElementById("mapGpsStatus");
        if (!el) return;
        el.textContent = text;
        if (loading) el.classList.add("loading");
        else el.classList.remove("loading");
    }

    function ndmIsImageFile(file) {
        if (file.type && file.type.indexOf("image/") === 0) return true;
        return /\.(jpe?g|png|tiff?|heic|heif|webp|avif)$/i.test(file.name);
    }

    function initNdmGpsMap() {
        if (ndmGpsMap || typeof L === "undefined" || !document.getElementById("mapGps")) return;
        ndmGpsMap = L.map("mapGps", { scrollWheelZoom: true }).setView(DEFAULT_GPS_VIEW.center, DEFAULT_GPS_VIEW.zoom);
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
            attribution: "&copy; OpenStreetMap &copy; CARTO",
            subdomains: "abcd",
            maxZoom: 20
        }).addTo(ndmGpsMap);
        ndmGpsMarkers = L.layerGroup().addTo(ndmGpsMap);
        $(window).on("resize.ndmGps", function() {
            if (ndmGpsMap) ndmGpsMap.invalidateSize();
        });
    }

    function ndmEscapeHtml(s) {
        var div = document.createElement("div");
        div.textContent = s;
        return div.innerHTML;
    }

    function ndmFormatCoord(n) {
        return (typeof n === "number" && !isNaN(n)) ? n.toFixed(6) : "—";
    }

    function renderNdmFileRows(results) {
        var panel = document.getElementById("ndmFilePanel");
        var list = document.getElementById("ndmFileList");
        if (!panel || !list) return;
        list.innerHTML = "";

        if (!results.length) {
            panel.hidden = true;
            return;
        }
        panel.hidden = false;

        results.forEach(function(r) {
            var li = document.createElement("li");
            var hasGps = r.lat != null && r.lng != null;

            var name = document.createElement("span");
            name.className = "name";
            name.textContent = r.file.name;

            var meta = document.createElement("span");
            meta.className = "meta";
            meta.textContent = (r.file.size / (1024 * 1024)).toFixed(2) + " MB";

            var gps = document.createElement("span");
            gps.className = "gps";
            if (hasGps) {
                gps.classList.add("has");
                gps.textContent = "GPS " + ndmFormatCoord(r.lat) + ", " + ndmFormatCoord(r.lng);
            } else {
                gps.classList.add("missing");
                gps.textContent = r.error ? ("Could not read GPS (" + r.error + ")") : "No GPS in EXIF";
            }

            li.appendChild(name);
            li.appendChild(meta);
            li.appendChild(gps);
            list.appendChild(li);
        });
    }

    function readGpsForNdmFile(file) {
        if (typeof exifr === "undefined") {
            return Promise.resolve({ file: file, lat: null, lng: null, error: "exifr not loaded" });
        }
        return exifr.gps(file).then(function(gps) {
            if (gps && typeof gps.latitude === "number" && typeof gps.longitude === "number") {
                return { file: file, lat: gps.latitude, lng: gps.longitude };
            }
            return { file: file, lat: null, lng: null };
        }).catch(function(err) {
            return { file: file, lat: null, lng: null, error: (err && err.message) ? err.message : "parse error" };
        });
    }

    function updateNdmGpsMap(points) {
        initNdmGpsMap();
        if (!ndmGpsMap || !ndmGpsMarkers) return;
        revokeNdmGpsPreviewUrls();
        ndmGpsMarkers.clearLayers();
        if (!points.length) {
            ndmGpsMap.setView(DEFAULT_GPS_VIEW.center, DEFAULT_GPS_VIEW.zoom);
            return;
        }
        var latlngs = points.map(function(p) { return [p.lat, p.lng]; });
        points.forEach(function(p) {
            var m = L.marker([p.lat, p.lng], {
                icon: L.divIcon({
                    className: "map-marker-wrap",
                    html: "<div class=\"map-pin\"></div>",
                    iconSize: [16, 16],
                    iconAnchor: [8, 8],
                    popupAnchor: [0, -8]
                })
            });
            var previewBlock = "";
            if (p.file && ndmIsImageFile(p.file) && ndmFileLikelyDisplayableInImgTag(p.file) && typeof URL !== "undefined" && URL.createObjectURL) {
                try {
                    var blobUrl = URL.createObjectURL(p.file);
                    ndmGpsPreviewUrls.push(blobUrl);
                    previewBlock =
                        "<div class=\"map-popup-preview-wrap\"><img class=\"map-popup-preview\" src=\"" +
                        blobUrl + "\" alt=\"Preview: " + ndmEscapeHtml(p.file.name) + "\"></div>";
                } catch (e) {
                    previewBlock = "";
                }
            } else if (p.file && ndmIsImageFile(p.file)) {
                previewBlock = "<p class=\"map-popup-preview-note\">Preview not shown for this format (open the file locally to view).</p>";
            }
            m.bindPopup(
                "<div class=\"map-popup\">" + previewBlock +
                "<strong>" + ndmEscapeHtml(p.file.name) + "</strong><br>" +
                "Lat " + ndmFormatCoord(p.lat) + ", Lng " + ndmFormatCoord(p.lng) + "</div>",
                { maxWidth: 320, className: "ndm-gps-popup" }
            );
            ndmGpsMarkers.addLayer(m);
        });
        if (latlngs.length === 1) {
            ndmGpsMap.setView(latlngs[0], 17);
        } else {
            ndmGpsMap.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 18 });
        }
        setTimeout(function() { if (ndmGpsMap) ndmGpsMap.invalidateSize(); }, 100);
    }

    function refreshGpsFromDropzone() {
        initNdmGpsMap();
        var files = (dz.files || []).filter(ndmIsImageFile);
        if (!files.length) {
            updateNdmGpsMap([]);
            renderNdmFileRows([]);
            setMapGpsStatus("Add images in the drop zone to read GPS from EXIF.", false);
            return;
        }
        setMapGpsStatus("Reading GPS from EXIF…", true);
        Promise.all(files.map(readGpsForNdmFile)).then(function(results) {
            var withGps = results.filter(function(r) { return r.lat != null && r.lng != null; });
            renderNdmFileRows(results);
            updateNdmGpsMap(withGps);
            if (typeof exifr === "undefined") {
                setMapGpsStatus("GPS preview unavailable (exifr failed to load).", false);
            } else if (!withGps.length) {
                setMapGpsStatus("No GPS tags found in " + files.length + " image(s).", false);
            } else if (withGps.length < files.length) {
                setMapGpsStatus(withGps.length + " of " + files.length + " images have GPS — shown on the map.", false);
            } else {
                setMapGpsStatus(withGps.length + " images plotted from EXIF GPS.", false);
            }
        });
    }

    function scheduleGpsFromDropzone() {
        clearTimeout(gpsMapTimer);
        gpsMapTimer = setTimeout(refreshGpsFromDropzone, 220);
    }

    dz.on("processing", function(file){
        this.options.url = '/task/new/upload/' + app.uuid() + "?token=" + token;
        app.fileUploadStatus.set(file.name, 0);
    })
    .on("error", function(file){
        // Retry
        console.log("Error uploading ", file, " put back in queue...");
        app.error("Upload of " + file.name + " failed, retrying...");
        file.status = Dropzone.QUEUED;
        app.fileUploadStatus.remove(file.name);
        dz.processQueue();
    })
    .on("uploadprogress", function(file, progress){
        app.fileUploadStatus.set(file.name, progress);
    })
    .on("addedfiles", function(files){
        app.filesCount(app.filesCount() + files.length);
        scheduleGpsFromDropzone();
    })
    .on("complete", function(file){
        if (file.status === "success"){
            app.uploadedFiles(app.uploadedFiles() + 1);
        }
        app.fileUploadStatus.remove(file.name);
        dz.processQueue();
    })
    .on("queuecomplete", function(files){
        // Commit
        $.ajax("/task/new/commit/" + app.uuid() + "?token=" + token, {
            type: "POST",
        }).done(function(json){
            if (json.uuid){
                taskList.add(new Task(json.uuid));
                app.resetUpload();
            }else{
                app.error(json.error || json);
            }
            app.uploading(false);
        }).fail(function(){
            app.error("Cannot commit task. Is the server available and are you connected to the internet?");
            app.uploading(false);
        });
    })
    .on("reset", function(){
        app.filesCount(0);
        scheduleGpsFromDropzone();
    })
    .on("removedfile", function(){
        scheduleGpsFromDropzone();
    });

    setTimeout(scheduleGpsFromDropzone, 400);

    app = new App();
    var appRoot = document.getElementById("app");
    if (appRoot) {
        ko.applyBindings(app, appRoot);
    }

    function query(key) {
        key = key.replace(/[*+?^$.\[\]{}()|\\\/]/g, "\\$&"); // escape RegEx meta chars
        var match = location.search.match(new RegExp("[?&]"+key+"=([^&]+)(&|$)"));
        return match && decodeURIComponent(match[1].replace(/\+/g, " "));
    }

    var token = query('token') || "";

    function hoursMinutesSecs(t) {
        var ch = 60 * 60 * 1000,
            cm = 60 * 1000,
            h = Math.floor(t / ch),
            m = Math.floor((t - h * ch) / cm),
            s = Math.round((t - h * ch - m * cm) / 1000),
            pad = function(n) { return n < 10 ? '0' + n : n; };
        if (s === 60) {
            m++;
            s = 0;
        }
        if (m === 60) {
            h++;
            m = 0;
        }
        return [pad(h), pad(m), pad(s)].join(':');
    }

    function TaskList() {
        var self = this;
        var url = "/task/list?token=" + token;
        this.error = ko.observable("");
        this.listLoading = ko.observable(true);
        this.listLoadingSlow = ko.observable(false);
        this.tasks = ko.observableArray();

        var listSlowTimer = setTimeout(function() {
            if (self.listLoading()) self.listLoadingSlow(true);
        }, 280);

        $.get(url)
            .done(function(tasksJson) {
                if (tasksJson.error){
                    self.error(tasksJson.error);
                }else{
                    for (var i in tasksJson){
                        self.tasks.push(new Task(tasksJson[i].uuid));
                    }
                }
            })
            .fail(function() {
                self.error(url + " is unreachable.");
            })
            .always(function() {
                clearTimeout(listSlowTimer);
                self.listLoadingSlow(false);
                self.listLoading(false);
            });
    }
    TaskList.prototype.add = function(task) {
        this.tasks.push(task);
    };
    TaskList.prototype.remove = function(task) {
        this.tasks.remove(function(t) {
            return t === task;
        });
    };

    var codes = {
        QUEUED: 10,
        RUNNING: 20,
        FAILED: 30,
        COMPLETED: 40,
        CANCELED: 50
    };

    function Task(uuid) {
        var self = this;

        this.uuid = uuid;
        this.loading = ko.observable(true);
        this.info = ko.observable({});
        this.viewingOutput = ko.observable(false);
        this.output = ko.observableArray();
        this.resetOutput();
        this.timeElapsed = ko.observable("00:00:00");
        this.expanded = ko.observable(true);
        this.toggleExpanded = function() {
            self.expanded(!self.expanded());
        };

        var statusCodes = {
            10: { descr: "Queued" },
            20: { descr: "Running" },
            30: { descr: "Failed" },
            40: { descr: "Completed" },
            50: { descr: "Canceled" }
        };

        this.statusDescr = ko.pureComputed(function() {
            if (this.info().status && this.info().status.code) {
                if (statusCodes[this.info().status.code]) {
                    return statusCodes[this.info().status.code].descr;
                } else return "Unknown (Status Code: " + this.info().status.code + ")";
            } else return "-";
        }, this);
        this.iconSymbol = ko.pureComputed(function() {
            var code = this.info().status && this.info().status.code;
            if (!code) return "";
            if (code === 10) return "⏳";
            if (code === 20) return "⚙";
            if (code === 30) return "!";
            if (code === 40) return "✓";
            if (code === 50) return "⊘";
            return "?";
        }, this);
        this.showCancel = ko.pureComputed(function() {
            return this.info().status &&
                (this.info().status.code === codes.QUEUED || this.info().status.code === codes.RUNNING);
        }, this);
        this.showRestart = ko.pureComputed(function() {
            return this.info().status &&
                (this.info().status.code === codes.CANCELED);
        }, this);
        this.showRemove = ko.pureComputed(function() {
            return this.info().status &&
                (this.info().status.code === codes.FAILED || this.info().status.code === codes.COMPLETED || this.info().status.code === codes.CANCELED);
        }, this);
        this.showDownload = ko.pureComputed(function() {
            return this.info().status &&
                (this.info().status.code === codes.COMPLETED);
        }, this);
        this.startRefreshingInfo();
    }
    Task.prototype.refreshInfo = function() {
        var self = this;
        var url = "/task/" + this.uuid + "/info?token=" + token;
        $.get(url)
            .done(function(json) {
                // Track time

                if (json.processingTime && json.processingTime !== -1) {
                    self.timeElapsed(hoursMinutesSecs(json.processingTime));
                }
                if (json.status && json.status.code && [codes.COMPLETED, codes.FAILED, codes.CANCELED].indexOf(json.status.code) !== -1){
                    self.stopRefreshingInfo();
                    self.copyOutput();
                }

                self.info(json);
            })
            .fail(function() {
                self.info({ error: url + " is unreachable." });
            })
            .always(function() { self.loading(false); });
    };
    Task.prototype.consoleMouseOver = function() { this.autoScrollOutput = false; };
    Task.prototype.consoleMouseOut = function() { this.autoScrollOutput = true; };
    Task.prototype.resetOutput = function() {
        this.viewOutputLine = 0;
        this.autoScrollOutput = true;
        this.output.removeAll();
    };
    Task.prototype.openInfo = function(){
        location.href='/task/' + this.uuid + '/info?token=' + token;
    };
    Task.prototype.copyOutput = function(){
        var self = this;
        var url = "/task/" + self.uuid + "/output";
            $.get(url, { token: token })
                .done(function(output) {
                    localStorage.setItem(self.uuid + '_output', JSON.stringify(output));
                })
                .fail(function() {
                    console.warn("Cannot copy output for " + self.uuid);
                });
    };
    Task.prototype.downloadOutput = function(){
        var self = this;
        var url = "/task/" + self.uuid + "/output";
            $.get(url, { token: token })
                .done(function(output) {
                    var wnd = window.open("about:blank", "", "_blank");
                    if (output.length === 0){
                        output = JSON.parse(localStorage.getItem(self.uuid + '_output') || []);
                    }
                    wnd.document.write(output.join("<br/>"));
                })
                .fail(function() {
                    self.info({ error: url + " is unreachable." });
                });
    };
    Task.prototype.viewOutput = function() {
        var self = this;

        function fetchOutput() {
            var url = "/task/" + self.uuid + "/output";
            $.get(url, { line: -9, token: token })
                .done(function(output) {
                    if (output.length === 0){
                        output = JSON.parse(localStorage.getItem(self.uuid + '_output') || []);
                    }
                    self.output(output);
                })
                .fail(function() {
                    self.info({ error: url + " is unreachable." });
                });
        }
        this.fetchOutputInterval = setInterval(fetchOutput, 5000);
        fetchOutput();

        this.viewingOutput(true);
    };
    Task.prototype.hideOutput = function() {
        if (this.fetchOutputInterval) clearInterval(this.fetchOutputInterval);
        this.viewingOutput(false);
    };
    Task.prototype.startRefreshingInfo = function() {
        var self = this;
        this.stopRefreshingInfo();
        this.refreshInfo();
        this.refreshInterval = setInterval(function() {
            self.refreshInfo();
        }, 2000);
    };
    Task.prototype.stopRefreshingInfo = function() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    };
    Task.prototype.remove = function() {
        var self = this;
        var url = "/task/remove?token=" + token;

        function doRemove() {
            localStorage.removeItem(self.uuid + '_output');

            $.post(url, {
                    uuid: self.uuid
                })
                .done(function(json) {
                    if (json.success || self.info().error) {
                        taskList.remove(self);
                    } else {
                        self.info({ error: json.error });
                    }

                    self.stopRefreshingInfo();
                })
                .fail(function() {
                    self.info({ error: url + " is unreachable." });
                    self.stopRefreshingInfo();
                });
        }

        if (this.info().status && this.info().status.code === codes.COMPLETED) {
            if (confirm("Are you sure?")) doRemove();
        } else {
            doRemove();
        }
    };

    function genApiCall(url, onSuccess) {
        return function() {
            var self = this;

            $.post(url, {
                    uuid: this.uuid
                })
                .done(function(json) {
                    if (json.success) {
                        if (onSuccess !== undefined) onSuccess(self, json);
                        self.startRefreshingInfo();
                    } else {
                        self.stopRefreshingInfo();
                        self.info({ error: json.error });
                    }
                })
                .fail(function() {
                    self.info({ error: url + " is unreachable." });
                    self.stopRefreshingInfo();
                });
        };
    }
    Task.prototype.cancel = genApiCall("/task/cancel?token=" + token);
    Task.prototype.restart = genApiCall("/task/restart?token=" + token, function(task) {
        task.resetOutput();
    });
    Task.prototype.downloadLink = function(){
        return "/task/" + this.uuid + "/download/all.zip?token=" + token;
    };
    Task.prototype.download = function() {
        location.href = this.downloadLink();
    };

    var taskList = new TaskList();
    var taskListRoot = document.getElementById("taskList");
    if (taskListRoot) {
        ko.applyBindings(taskList, taskListRoot);
    }

    $('#resetWebhook').on('click', function(){
        $("#webhook").val('');
    });

    $('#resetDoPostProcessing').on('click', function(){
        $("#doPostProcessing").prop('checked', false);
    });
    $('#resetTaskName').on('click', function(){
        $("#taskName").val('');
    });


    function mergeUiDefaultsIntoOptionRows(rows, defaultsMap) {
        if (!Array.isArray(rows) || !defaultsMap || typeof defaultsMap !== "object" || defaultsMap.error) return;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!row || typeof row.name !== "string") continue;
            if (!Object.prototype.hasOwnProperty.call(defaultsMap, row.name)) continue;
            var v = String(defaultsMap[row.name]);
            row.value = v;
            if (row.type === "enum" && Array.isArray(row.domain) && row.domain.indexOf(v) === -1) {
                row.domain = [v].concat(row.domain.slice());
            }
        }
    }

    function deepCloneOptionRow(row) {
        return $.extend(true, {}, row);
    }

    // Load options: /options + /option-ui-defaults (same token as this page) merged on the client so the form always matches odmUiDefaults.js.
    function Option(properties) {
        this.properties = properties;

        var raw = properties.value;
        if (properties.type === 'bool' && typeof raw !== 'string') {
            properties.value = raw === true || raw === 1 || raw === '1' ? 'true' : 'false';
        } else if ((properties.type === 'int' || properties.type === 'integer' || properties.type === 'float' || properties.type === 'double') && typeof raw === 'number') {
            properties.value = String(raw);
        }

        this.defaultValue = undefined;
        if (properties.type === 'bool') {
            this.defaultValue = properties.value === true || properties.value === 'true' ||
                properties.value === 1 || properties.value === '1';
        } else if (properties.type === 'enum') {
            this.defaultValue = properties.value != null ? String(properties.value) : undefined;
        } else if (properties.type === 'int' || properties.type === 'integer') {
            var vi = typeof properties.value === 'number' ? properties.value : parseInt(properties.value, 10);
            this.defaultValue = typeof vi === 'number' && !isNaN(vi) ? String(vi) : undefined;
        } else if (properties.type === 'float' || properties.type === 'double') {
            var vf = typeof properties.value === 'number' ? properties.value : parseFloat(properties.value);
            this.defaultValue = typeof vf === 'number' && !isNaN(vf) ? String(vf) : undefined;
        } else if (properties.type === 'string' || properties.type === 'path') {
            this.defaultValue = properties.value;
        }

        if (this.defaultValue === undefined && properties.type !== 'bool' &&
                properties.value !== undefined && properties.value !== null && String(properties.value) !== '') {
            this.defaultValue = properties.value;
        }

        if (this.properties.help !== undefined && this.properties.domain !== undefined){
            var choicesStr = typeof this.properties.domain === "object" ? this.properties.domain.join(", ") : this.properties.domain;

            this.properties.help = this.properties.help.replace(/\%\(choices\)s/g, choicesStr);
            this.properties.help = this.properties.help.replace(/\%\(default\)s/g, String(this.properties.value));
        }

        var dom = this.properties.domain;
        this.domainTooltipText = "";
        if (dom !== undefined && dom !== null && dom !== "") {
            this.domainTooltipText = Array.isArray(dom) ? dom.join(", ") : String(dom);
        }

        var helpStr = this.properties.help;
        this.hasHelpDetail = typeof helpStr === "string" && helpStr.trim().length > 0;

        this.value = ko.observable(this.defaultValue);
    }
    Option.prototype.resetToDefault = function() {
        this.value(this.defaultValue);
    };

    function OptionsModel() {
        var self = this;

        this.options = ko.observableArray();
        this.showOptions = ko.observable(false);
        this.error = ko.observable();

        var ts = Date.now();
        var optUrl = "/options?token=" + encodeURIComponent(token) + "&_=" + ts;
        var staticDefUrl = "/js/ndm-ui-defaults.json?_=" + ts;
        var apiDefUrl = "/option-ui-defaults?token=" + encodeURIComponent(token) + "&_=" + ts;

        function finishBuild(rows) {
            self.options.removeAll();
            for (var i = 0; i < rows.length; i++) {
                self.options.push(new Option(deepCloneOptionRow(rows[i])));
            }
        }

        function fetchDefaultsMap(cb) {
            $.ajax({ url: staticDefUrl, dataType: "json", cache: false })
                .done(function(d) { cb(d); })
                .fail(function() {
                    $.ajax({ url: apiDefUrl, dataType: "json", cache: false })
                        .done(function(d) { cb(d); })
                        .fail(function() { cb(null); });
                });
        }

        $.ajax({ url: optUrl, dataType: "json" })
            .done(function(json) {
                if (json.error) {
                    self.error(json.error);
                    return;
                }
                if (!Array.isArray(json)) {
                    self.error("options are not available.");
                    return;
                }
                fetchDefaultsMap(function(defMap) {
                    if (defMap) mergeUiDefaultsIntoOptionRows(json, defMap);
                    finishBuild(json);
                });
            })
            .fail(function() {
                self.error("options are not available.");
            });
    }
    OptionsModel.prototype.getUserOptions = function() {
        var result = [];
        for (var i = 0; i < this.options().length; i++) {
            var opt = this.options()[i];
            if (opt.properties.type === 'enum'){
                if (opt.value() !== opt.defaultValue){
                    result.push({
                        name: opt.properties.name,
                        value: opt.value()
                    });
                }
            }else{
                if (opt.value() !== undefined) {
                    /* Leave max-concurrency out when unchanged so the server uses RAM-based parallelism (see odmInfo.filterOptions). */
                    if (opt.properties.name === "max-concurrency" &&
                            String(opt.value()) === String(opt.defaultValue)) {
                        continue;
                    }
                    result.push({
                        name: opt.properties.name,
                        value: opt.value()
                    });
                }
            }
        }
        return result;
    };

    function ndmNormOptionName(n) {
        if (n == null || n === "") return "";
        return String(n).replace(/^--+/, "").trim().toLowerCase();
    }

    function buildTaskOptions() {
        var raw = optionsModel.getUserOptions();
        var filtered = raw.filter(function(o) {
            if (!o || !o.name) return false;
            var nn = ndmNormOptionName(o.name);
            if (nn === "fast-orthophoto" || nn === "optimize-disk-space") return false;
            // Advanced CLI JSON/path flags; the web UI does not edit these reliably (hidden bindings).
            // REST/API clients can still pass them. Omitting avoids spurious filterOptions errors.
            if (nn === "cameras" || nn === "boundary") return false;
            // Optional ClusterODM URL; /options default is often the literal string "None" from Python.
            if (nn === "sm-cluster") return false;
            return true;
        });
        function ndmEnsureTaskOption(arr, name, value) {
            var k = ndmNormOptionName(name);
            for (var i = 0; i < arr.length; i++) {
                if (arr[i] && ndmNormOptionName(arr[i].name) === k) {
                    arr[i].value = value;
                    return;
                }
            }
            arr.push({ name: name, value: value });
        }
        ndmEnsureTaskOption(filtered, "fast-orthophoto", false);
        ndmEnsureTaskOption(filtered, "optimize-disk-space", false);
        return filtered;
    }

    var optionsModel = new OptionsModel();
    var optionsRoot = document.getElementById("options");
    if (optionsRoot) {
        ko.applyBindings(optionsModel, optionsRoot);
    }

    (function setupNdmMapCollapse() {
        var key = "ndmGpsMapCollapsed";
        var panel = document.getElementById("ndmGpsPanel");
        var btn = document.getElementById("ndmMapToggle");
        if (!panel || !btn) return;

        var stored = null;
        try { stored = localStorage.getItem(key); } catch (e) {}
        var startCollapsed = stored === "1";
        panel.classList.toggle("ndm-map-panel--collapsed", startCollapsed);
        btn.setAttribute("aria-expanded", startCollapsed ? "false" : "true");
        btn.textContent = startCollapsed ? "Show map" : "Hide map";

        btn.addEventListener("click", function() {
            var collapsed = !panel.classList.contains("ndm-map-panel--collapsed");
            panel.classList.toggle("ndm-map-panel--collapsed", collapsed);
            btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
            btn.textContent = collapsed ? "Show map" : "Hide map";
            try { localStorage.setItem(key, collapsed ? "1" : "0"); } catch (e2) {}
            if (!collapsed) {
                setTimeout(function() {
                    if (ndmGpsMap) ndmGpsMap.invalidateSize();
                }, 200);
            }
        });
    })();
});