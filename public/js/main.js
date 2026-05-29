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

    function query(key) {
        key = key.replace(/[*+?^$.\[\]{}()|\\\/]/g, "\\$&");
        var match = location.search.match(new RegExp("[?&]"+key+"=([^&]+)(&|$)"));
        return match && decodeURIComponent(match[1].replace(/\+/g, " "));
    }

    var token = query("token") || "";

    /**
     * API origin for /task/*, /options, etc.
     * Override: window.NDM_API_BASE, <meta name="ndm-api-base" content="...">,
     * URL ?ndm_api=http://127.0.0.1:3000 or ?ndm_port=3000 (uses current hostname).
     * If the page is file:// or a common static-dev port, defaults to http://127.0.0.1:3000 (NodeODM’s usual port).
     */
    function ndmApiRoot() {
        if (typeof window !== "undefined" && window.NDM_API_BASE) {
            return String(window.NDM_API_BASE).replace(/\/$/, "");
        }
        var meta = typeof document !== "undefined" && document.querySelector && document.querySelector("meta[name=\"ndm-api-base\"]");
        if (meta) {
            var c = (meta.getAttribute("content") || "").trim();
            if (c) return c.replace(/\/$/, "");
        }
        var apiFromQs = query("ndm_api");
        if (apiFromQs) return String(apiFromQs).replace(/\/$/, "");
        var portQs = query("ndm_port");
        if (portQs && /^\d+$/.test(portQs) && typeof location !== "undefined" && location.hostname) {
            var pproto = location.protocol === "https:" ? "https:" : "http:";
            return pproto + "//" + location.hostname + ":" + portQs;
        }
        if (typeof location !== "undefined") {
            if (location.protocol === "file:") {
                return "http://127.0.0.1:3000";
            }
            var p = String(location.port || "");
            if (p === "80" || p === "443") p = "";
            var staticDevPorts = { "5500": 1, "8080": 1, "5173": 1, "4173": 1, "1234": 1, "3001": 1, "5501": 1 };
            if (p && staticDevPorts[p]) {
                return "http://127.0.0.1:3000";
            }
        }
        return "";
    }

    function ndmApi(path) {
        var root = ndmApiRoot();
        var prefix = "";
        if (typeof window !== "undefined" && window.NDM_API_PATH_PREFIX) {
            prefix = String(window.NDM_API_PATH_PREFIX).replace(/\/$/, "");
        } else {
            var metaP = typeof document !== "undefined" && document.querySelector && document.querySelector("meta[name=\"ndm-api-path-prefix\"]");
            if (metaP) {
                var mp = (metaP.getAttribute("content") || "").trim().replace(/\/$/, "");
                if (mp) prefix = mp;
            }
        }
        if (!path || path.charAt(0) !== "/") path = "/" + (path || "");
        return root + prefix + path;
    }

    function ndmTokenQs() {
        return token ? "?token=" + encodeURIComponent(token) : "";
    }

    function ndmAjaxFailMessage(xhr, textStatus, attemptedUrl) {
        if (xhr && xhr.responseJSON && xhr.responseJSON.error) return xhr.responseJSON.error;
        if (textStatus === "parsererror") {
            return "The server did not return JSON. Open this UI from your NodeODM URL, or set window.NDM_API_BASE to the API root.";
        }
        if (xhr && xhr.status === 0) {
            var displayUrl = attemptedUrl;
            if (displayUrl && displayUrl.indexOf("http") !== 0 && typeof location !== "undefined") {
                displayUrl = location.origin + displayUrl;
            }
            return "Cannot reach the API at " + (displayUrl || "this URL") + ". Use the same host/port as NodeODM, or set window.NDM_API_BASE (e.g. http://127.0.0.1:3000).";
        }
        if (xhr && xhr.status === 404) {
            var url404 = attemptedUrl;
            if (url404 && url404.indexOf("http") !== 0 && typeof location !== "undefined") {
                url404 = location.origin + url404;
            }
            return "404 for " + (url404 || "this URL") + " — wrong API host/path. Try: open this page from NodeODM (same port), add ?ndm_port=PORT (NodeODM’s port) to the URL, set window.NDM_API_BASE, or NDM_API_PATH_PREFIX if the API is under a subpath.";
        }
        if (xhr && xhr.status >= 400) {
            return "Request failed (" + xhr.status + "): " + (attemptedUrl || "");
        }
        return (attemptedUrl || "Request") + " is unreachable.";
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
        clearNdmRtkState();
        dz.removeAllFiles(true);
    };
    App.prototype.startTask = function(){
        var self = this;
        this.error("");
        this.uuid("");

        var die = function(err){
            self.error(err);
            self.uploading(false);
        };

        var projectName = ($("#taskName").val() || "").trim();
        if (!projectName) {
            die("Please enter a project name before starting a task.");
            $("#taskName").focus();
            return;
        }

        this.uploading(true);

        // Start upload
        var formData = new FormData();
        formData.append("name", projectName);
        formData.append("webhook", $("#webhook").val());
        formData.append("skipPostProcessing", !$("#doPostProcessing").prop('checked'));
        formData.append("options", JSON.stringify(buildTaskOptions()));
        // formData.append("outputs", JSON.stringify(['odm_orthophoto/odm_orthophoto.tif']));

        if (this.mode() === 'file'){
            if (this.filesCount() > 0){
                $.ajax(ndmApi("/task/new/init") + ndmTokenQs(), {
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

            $.ajax(ndmApi("/task/new") + ndmTokenQs(), {
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
        url : ndmApi("/task/new/upload/"),
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

    (function() {
        var origSubmit = Dropzone.prototype.submitRequest;
        dz.submitRequest = function(xhr, formData, files) {
            var f = files && files[0];
            if (f && ndmIsImageFile(f) && ndmDeselectedIds.has(ndmPhotoKey(f))) {
                var self = this;
                window.setTimeout(function() {
                    if (!f.upload) f.upload = { progress: 0, total: f.size, bytesSent: 0 };
                    f.upload.progress = 100;
                    f.upload.bytesSent = f.size;
                    f.upload.total = f.size;
                    self.emit("uploadprogress", f, 100, f.size);
                    f.status = Dropzone.SUCCESS;
                    self.emit("success", f, "", null);
                    self.emit("complete", f);
                }, 0);
                return;
            }
            return origSubmit.call(this, xhr, formData, files);
        };
    })();

    var DEFAULT_GPS_VIEW = { center: [20, 0], zoom: 2 };
    var ndmGpsMap = null;
    var ndmGpsMarkers = null;
    var gpsMapTimer = null;
    var rtkMapTimer = null;
    var ndmRtkXhr = null;
    var ndmRtkRequestSeq = 0;
    var ndmRtkSessionId = null;
    var ndmRtkActiveXhrs = [];
    var ndmRtkByFilename = Object.create(null);
    var ndmRtkSessionUpload = null;
    var ndmRtkAjaxOpts = { xhrFields: { withCredentials: true } };
    var ndmRtkEnabled = true;
    /** Blob URLs for map popup previews; revoked when markers refresh */
    var ndmGpsPreviewUrls = [];
    var ndmLastGpsResults = [];
    var ndmGpsPoints = [];
    var ndmMarkersById = Object.create(null);
    var ndmDeselectedIds = new Set();
    var ndmDeselectMode = false;
    var ndmPolygonDrawing = false;
    var ndmPolyVertices = [];
    var ndmDrawPolyline = null;
    var ndmBtnDeselectEl = null;
    var ndmBtnPolyEl = null;
    var ndmDeselectToolsAdded = false;

    function ndmPhotoKey(file) {
        if (!file) return "";
        return file.name + "\0" + String(file.size);
    }

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

    function ndmPointInGpsPolygon(latlng, ring) {
        var x = latlng.lng;
        var y = latlng.lat;
        var inside = false;
        var i;
        var j;
        for (i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            var xi = ring[i].lng;
            var yi = ring[i].lat;
            var xj = ring[j].lng;
            var yj = ring[j].lat;
            var denom = yj - yi;
            if (denom === 0) denom = 1e-12;
            var intersect = (yi > y) !== (yj > y) &&
                x < ((xj - xi) * (y - yi)) / denom + xi;
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function ndmGpsMarkerIcon(selected) {
        var html = selected
            ? "<div class=\"map-pin map-pin--selected\"></div>"
            : "<div class=\"map-pin map-pin--deselected\"><span aria-hidden=\"true\">×</span></div>";
        return L.divIcon({
            className: "map-marker-wrap",
            html: html,
            iconSize: [26, 26],
            iconAnchor: [13, 13],
            popupAnchor: [0, -12]
        });
    }

    function ndmGpsPopupFullHtml(p) {
        var ex = ndmDeselectedIds.has(p.key);
        var incl = ex ? "<em>Excluded from processing</em>" : "<em>Included in processing</em>";
        return "<div class=\"map-popup\">" + (p._previewBlock || "") +
            "<strong>" + ndmEscapeHtml(p.file.name) + "</strong><br>" +
            "Lat " + ndmFormatCoord(p.lat) + ", Lng " + ndmFormatCoord(p.lng) + "<br>" +
            incl + "</div>";
    }

    function ndmSyncGpsMarkerPopups() {
        var k;
        for (k in ndmMarkersById) {
            if (!Object.prototype.hasOwnProperty.call(ndmMarkersById, k)) continue;
            var m = ndmMarkersById[k];
            var pt = m._photoPoint;
            if (!pt) continue;
            if (ndmDeselectMode) {
                m.unbindPopup();
            } else {
                m.bindPopup(ndmGpsPopupFullHtml(pt), { maxWidth: 320, className: "ndm-gps-popup" });
            }
        }
    }

    function ndmUpdateDeselectToolbarButtons() {
        if (ndmBtnDeselectEl) {
            ndmBtnDeselectEl.disabled = !ndmGpsPoints.length;
        }
        if (ndmBtnPolyEl) {
            ndmBtnPolyEl.disabled = !ndmDeselectMode || !ndmGpsPoints.length;
            if (ndmBtnPolyEl.disabled) ndmBtnPolyEl.classList.remove("active");
        }
    }

    function ndmEndPolygonDraw(apply) {
        var polygonBanner = document.getElementById("ndmPolygonBanner");
        ndmPolygonDrawing = false;
        if (polygonBanner) polygonBanner.hidden = true;
        if (ndmGpsMap) ndmGpsMap.doubleClickZoom.enable();
        if (ndmBtnPolyEl) ndmBtnPolyEl.classList.remove("active");
        if (ndmDrawPolyline && ndmGpsMap) {
            ndmGpsMap.removeLayer(ndmDrawPolyline);
            ndmDrawPolyline = null;
        }
        if (apply && ndmPolyVertices.length >= 3) {
            ndmGpsPoints.forEach(function(p) {
                if (ndmPointInGpsPolygon(L.latLng(p.lat, p.lng), ndmPolyVertices)) {
                    ndmDeselectedIds.add(p.key);
                }
            });
            ndmRefreshAllGpsMarkerIcons();
            renderNdmFileRows(ndmLastGpsResults);
        }
        ndmPolyVertices = [];
        ndmUpdateDeselectToolbarButtons();
    }

    function ndmStartPolygonDraw() {
        var polygonBanner = document.getElementById("ndmPolygonBanner");
        if (!ndmDeselectMode || !ndmGpsPoints.length || !ndmGpsMap) return;
        ndmPolygonDrawing = true;
        ndmPolyVertices = [];
        if (ndmDrawPolyline) {
            ndmGpsMap.removeLayer(ndmDrawPolyline);
            ndmDrawPolyline = null;
        }
        ndmDrawPolyline = L.polyline([], { color: "#ff6b6b", weight: 2, dashArray: "6 8" }).addTo(ndmGpsMap);
        if (polygonBanner) polygonBanner.hidden = false;
        ndmGpsMap.doubleClickZoom.disable();
        if (ndmBtnPolyEl) ndmBtnPolyEl.classList.add("active");
    }

    function ndmOnMapGpsClickPolygon(e) {
        if (!ndmPolygonDrawing) return;
        ndmPolyVertices.push(e.latlng);
        ndmDrawPolyline.setLatLngs(ndmPolyVertices);
    }

    function ndmSetDeselectMode(on) {
        ndmDeselectMode = !!on;
        if (!ndmDeselectMode) {
            ndmEndPolygonDraw(false);
        }
        if (ndmBtnDeselectEl) {
            ndmBtnDeselectEl.classList.toggle("active", ndmDeselectMode);
            ndmBtnDeselectEl.setAttribute("aria-pressed", ndmDeselectMode ? "true" : "false");
        }
        var mapEl = document.getElementById("mapGps");
        if (mapEl) mapEl.classList.toggle("deselect-mode", ndmDeselectMode);
        ndmSyncGpsMarkerPopups();
        ndmUpdateDeselectToolbarButtons();
    }

    function ndmToggleGpsDeselectKey(key) {
        if (ndmDeselectedIds.has(key)) ndmDeselectedIds.delete(key);
        else ndmDeselectedIds.add(key);
        var m = ndmMarkersById[key];
        if (m) m.setIcon(ndmGpsMarkerIcon(!ndmDeselectedIds.has(key)));
        renderNdmFileRows(ndmLastGpsResults);
    }

    function ndmRefreshAllGpsMarkerIcons() {
        var k;
        for (k in ndmMarkersById) {
            if (!Object.prototype.hasOwnProperty.call(ndmMarkersById, k)) continue;
            ndmMarkersById[k].setIcon(ndmGpsMarkerIcon(!ndmDeselectedIds.has(k)));
        }
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
        ndmGpsMap.on("click", ndmOnMapGpsClickPolygon);

        var polyDone = document.getElementById("ndmPolyDone");
        var polyCancel = document.getElementById("ndmPolyCancel");
        if (polyDone) {
            polyDone.addEventListener("click", function() {
                if (!ndmPolygonDrawing) return;
                if (ndmPolyVertices.length < 3) {
                    window.alert("Add at least three corners before finishing the area.");
                    return;
                }
                ndmEndPolygonDraw(true);
            });
        }
        if (polyCancel) {
            polyCancel.addEventListener("click", function() {
                ndmEndPolygonDraw(false);
            });
        }

        if (!ndmDeselectToolsAdded) {
            ndmDeselectToolsAdded = true;
            var ICON_DESELECT = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M4.93 4.93l14.14 14.14\"/></svg>";
            var ICON_POLYGON = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 3l7 4v10l-7 4-7-4V7l7-4z\"/></svg>";
            var DeselectTools = L.Control.extend({
                options: { position: "topright" },
                onAdd: function() {
                    var el = L.DomUtil.create("div", "map-deselect-control leaflet-control");
                    L.DomEvent.disableClickPropagation(el);
                    L.DomEvent.disableScrollPropagation(el);
                    ndmBtnDeselectEl = L.DomUtil.create("button", "", el);
                    ndmBtnDeselectEl.type = "button";
                    ndmBtnDeselectEl.title = "Deselect mode — click photos or draw an area to exclude from processing";
                    ndmBtnDeselectEl.setAttribute("aria-label", "Toggle deselect mode");
                    ndmBtnDeselectEl.setAttribute("aria-pressed", "false");
                    ndmBtnDeselectEl.innerHTML = ICON_DESELECT;
                    ndmBtnPolyEl = L.DomUtil.create("button", "", el);
                    ndmBtnPolyEl.type = "button";
                    ndmBtnPolyEl.title = "Draw polygon — exclude every photo inside the shape";
                    ndmBtnPolyEl.setAttribute("aria-label", "Draw exclusion polygon");
                    ndmBtnPolyEl.disabled = true;
                    ndmBtnPolyEl.innerHTML = ICON_POLYGON;
                    L.DomEvent.on(ndmBtnDeselectEl, "click", function(ev) {
                        L.DomEvent.stopPropagation(ev);
                        if (!ndmGpsPoints.length) return;
                        ndmSetDeselectMode(!ndmDeselectMode);
                    });
                    L.DomEvent.on(ndmBtnPolyEl, "click", function(ev) {
                        L.DomEvent.stopPropagation(ev);
                        if (!ndmDeselectMode || !ndmGpsPoints.length) return;
                        if (ndmPolygonDrawing) ndmEndPolygonDraw(false);
                        else ndmStartPolygonDraw();
                    });
                    return el;
                }
            });
            ndmGpsMap.addControl(new DeselectTools());
            ndmUpdateDeselectToolbarButtons();
        }
    }

    function ndmEscapeHtml(s) {
        var div = document.createElement("div");
        div.textContent = s;
        return div.innerHTML;
    }

    function ndmFormatCoord(n) {
        return (typeof n === "number" && !isNaN(n)) ? n.toFixed(6) : "—";
    }

    function ndmRtkQualityClass(quality) {
        if (quality === "PASS") return "rtk-pass";
        if (quality === "WARN") return "rtk-warn";
        if (quality === "FAIL") return "rtk-fail";
        return "";
    }

    function ndmRtkLabelForRecord(rec) {
        if (!rec) return "RTK pending";
        if (rec.quality === "PASS") return "RTK " + (rec.rtk_solution || "PASS");
        return "RTK " + (rec.quality || "?") + " — " + (rec.rtk_solution || "unknown");
    }

    function setNdmRtkBadge(text, kind) {
        var badge = document.getElementById("ndmRtkBadge");
        if (!badge) return;
        badge.textContent = text;
        badge.className = "ndm-rtk-badge ndm-rtk-badge--" + (kind || "pending");
    }

    function setNdmRtkPanelVisible(visible) {
        var panel = document.getElementById("ndmRtkPanel");
        if (panel) panel.hidden = !visible;
    }

    function setNdmRtkLoading(loading) {
        var overlay = document.getElementById("ndmRtkLoading");
        var panel = document.getElementById("ndmRtkPanel");
        var status = document.getElementById("ndmRtkStatus");
        if (overlay) overlay.hidden = !loading;
        if (panel) panel.classList.toggle("ndm-rtk-panel--loading", !!loading);
        if (status) status.classList.toggle("loading", !!loading);
    }

    function abortNdmRtkWork() {
        ndmRtkActiveXhrs.forEach(function(x) {
            if (x && x.abort) {
                try { x.abort(); } catch (e) { /* ignore */ }
            }
        });
        ndmRtkActiveXhrs = [];
        if (ndmRtkXhr && ndmRtkXhr.abort) {
            try { ndmRtkXhr.abort(); } catch (e) { /* ignore */ }
        }
        ndmRtkXhr = null;
    }

    function destroyNdmRtkSession() {
        if (!ndmRtkSessionId) return;
        var sid = ndmRtkSessionId;
        ndmRtkSessionId = null;
        $.ajax($.extend({
            url: ndmApi("/rtk/session/" + sid) + ndmTokenQs(),
            type: "DELETE"
        }, ndmRtkAjaxOpts));
    }

    function trackNdmRtkXhr(xhr) {
        ndmRtkActiveXhrs.push(xhr);
        xhr.always(function() {
            var i = ndmRtkActiveXhrs.indexOf(xhr);
            if (i >= 0) ndmRtkActiveXhrs.splice(i, 1);
        });
        return xhr;
    }

    function clearNdmRtkState() {
        clearTimeout(rtkMapTimer);
        abortNdmRtkWork();
        destroyNdmRtkSession();
        ndmRtkByFilename = Object.create(null);
        var banner = document.getElementById("ndmRtkBanner");
        var stats = document.getElementById("ndmRtkStats");
        var details = document.getElementById("ndmRtkDetails");
        var flagged = document.getElementById("ndmRtkFlagged");
        var report = document.getElementById("ndmRtkReport");
        setNdmRtkPanelVisible(ndmRtkEnabled);
        if (banner) { banner.hidden = true; banner.textContent = ""; banner.className = "ndm-rtk-banner"; }
        if (stats) { stats.hidden = true; stats.innerHTML = ""; }
        if (details) details.hidden = true;
        if (flagged) flagged.innerHTML = "";
        if (report) report.textContent = "";
        setNdmRtkLoading(false);
        setNdmRtkStatus("Add DJI images in the drop zone to analyze RTK metadata automatically.");
        setNdmRtkBadge("Pending", "pending");
    }

    function setNdmRtkStatus(text) {
        var el = document.getElementById("ndmRtkStatus");
        if (el) el.textContent = text;
    }

    function updateNdmRtkUi(payload) {
        var panel = document.getElementById("ndmRtkPanel");
        var banner = document.getElementById("ndmRtkBanner");
        var stats = document.getElementById("ndmRtkStats");
        var details = document.getElementById("ndmRtkDetails");
        var flaggedEl = document.getElementById("ndmRtkFlagged");
        var reportEl = document.getElementById("ndmRtkReport");
        if (!panel) return;

        setNdmRtkLoading(false);
        setNdmRtkPanelVisible(true);
        var summary = payload.summary || {};
        var q = summary.quality || {};
        var severity = payload.severity || "ok";

        if (severity === "error") {
            setNdmRtkBadge("Issues found", "error");
        } else if (severity === "warn") {
            setNdmRtkBadge("Review recommended", "warn");
        } else {
            setNdmRtkBadge("All clear", "ok");
        }

        setNdmRtkStatus(payload.message || "RTK analysis complete.");

        if (banner) {
            if (payload.hasDiscrepancies) {
                banner.hidden = false;
                banner.textContent = payload.message || "RTK quality issues detected.";
                banner.className = "ndm-rtk-banner ndm-rtk-banner--" + (severity === "error" ? "error" : "warn");
            } else {
                banner.hidden = true;
                banner.textContent = "";
            }
        }

        if (stats) {
            stats.hidden = false;
            stats.innerHTML =
                "<span class=\"ndm-rtk-stat\"><strong>Images:</strong> " + (summary.total || 0) + "</span>" +
                "<span class=\"ndm-rtk-stat\"><strong>RTK fixed:</strong> " + (summary.fixed_pct != null ? summary.fixed_pct : "—") + "%</span>" +
                "<span class=\"ndm-rtk-stat\"><strong>PASS:</strong> " + (q.PASS || 0) + "</span>" +
                "<span class=\"ndm-rtk-stat\"><strong>WARN:</strong> " + (q.WARN || 0) + "</span>" +
                "<span class=\"ndm-rtk-stat\"><strong>FAIL:</strong> " + (q.FAIL || 0) + "</span>";
        }

        if (details && flaggedEl && reportEl) {
            var flagged = summary.flagged || [];
            flaggedEl.innerHTML = "";
            flagged.forEach(function(item) {
                var li = document.createElement("li");
                if (item.quality === "FAIL") li.classList.add("ndm-rtk-flagged--fail");
                var name = document.createElement("span");
                name.className = "name";
                name.textContent = item.filename;
                var issues = document.createElement("span");
                issues.className = "issues";
                issues.textContent = item.issues || item.rtk_solution || "";
                li.appendChild(name);
                li.appendChild(issues);
                flaggedEl.appendChild(li);
            });
            reportEl.textContent = payload.reportText || "";
            details.hidden = !(flagged.length || payload.reportText);
        }

        renderNdmFileRows(ndmLastGpsResults);
    }

    function uploadNdmRtkSessionFiles(sessionId, files, seq) {
        var def = $.Deferred();
        var uploaded = 0;
        var idx = 0;
        var active = 0;
        var concurrency = 4;
        var failed = null;

        function uploadOne(file) {
            var fd = new FormData();
            fd.append("images", file, file.name);
            return trackNdmRtkXhr($.ajax($.extend({
                url: ndmApi("/rtk/session/" + sessionId + "/upload") + ndmTokenQs(),
                type: "POST",
                data: fd,
                processData: false,
                contentType: false,
                timeout: 120000
            }, ndmRtkAjaxOpts)));
        }

        function pump() {
            if (failed || seq !== ndmRtkRequestSeq) {
                if (!failed) failed = { aborted: true };
                if (def.state() === "pending") def.reject(failed);
                return;
            }
            while (active < concurrency && idx < files.length) {
                var file = files[idx++];
                active++;
                uploadOne(file).done(function() {
                    active--;
                    uploaded++;
                    setNdmRtkStatus("Uploading " + uploaded + " / " + files.length + " for RTK analysis…");
                    if (uploaded >= files.length) {
                        def.resolve();
                    } else {
                        pump();
                    }
                }).fail(function(xhr, status) {
                    if (!failed) {
                        failed = {
                            xhr: xhr,
                            status: status,
                            url: ndmApi("/rtk/session/" + sessionId + "/upload")
                        };
                    }
                    active--;
                    if (def.state() === "pending") def.reject(failed);
                });
            }
        }

        if (!files.length) {
            def.resolve();
        } else {
            pump();
        }
        return def.promise();
    }

    function applyNdmRtkAnalysisResult(result, seq) {
        if (seq !== ndmRtkRequestSeq) return;
        setNdmRtkLoading(false);
        if (result.error) {
            setNdmRtkBadge("Unavailable", "pending");
            setNdmRtkStatus(result.error);
            return;
        }
        ndmRtkByFilename = Object.create(null);
        (result.records || []).forEach(function(rec) {
            ndmRtkByFilename[rec.filename] = rec;
        });
        updateNdmRtkUi(result);
    }

    function refreshRtkLegacyFromDropzone(files, seq) {
        setNdmRtkStatus("Uploading " + files.length + " image(s) for RTK analysis…");
        var formData = new FormData();
        files.forEach(function(f) {
            formData.append("images", f, f.name);
        });
        var analyzeUrl = ndmApi("/rtk/analyze");
        ndmRtkXhr = trackNdmRtkXhr($.ajax($.extend({
            url: analyzeUrl + ndmTokenQs(),
            type: "POST",
            data: formData,
            processData: false,
            contentType: false,
            timeout: 600000
        }, ndmRtkAjaxOpts))).done(function(result) {
            applyNdmRtkAnalysisResult(result, seq);
        }).fail(function(xhr, status) {
            if (seq !== ndmRtkRequestSeq || status === "abort") return;
            setNdmRtkLoading(false);
            setNdmRtkBadge("Error", "pending");
            setNdmRtkStatus(ndmAjaxFailMessage(xhr, status, analyzeUrl));
        });
    }

    function refreshRtkSessionFromDropzone(files, seq) {
        var analyzeUrl = "";

        ndmRtkXhr = trackNdmRtkXhr($.ajax($.extend({
            url: ndmApi("/rtk/session") + ndmTokenQs(),
            type: "POST"
        }, ndmRtkAjaxOpts))).done(function(sessionResp) {
            if (seq !== ndmRtkRequestSeq) return;
            if (sessionResp.error) {
                setNdmRtkLoading(false);
                setNdmRtkBadge("Unavailable", "pending");
                setNdmRtkStatus(sessionResp.error);
                return;
            }

            var sessionId = sessionResp.sessionId;
            ndmRtkSessionId = sessionId;
            analyzeUrl = ndmApi("/rtk/session/" + sessionId + "/analyze");

            uploadNdmRtkSessionFiles(sessionId, files, seq).done(function() {
                if (seq !== ndmRtkRequestSeq) return;
                setNdmRtkStatus("Running RTK analysis…");

                ndmRtkXhr = trackNdmRtkXhr($.ajax($.extend({
                    url: analyzeUrl + ndmTokenQs(),
                    type: "POST",
                    timeout: 600000
                }, ndmRtkAjaxOpts))).done(function(result) {
                    if (seq !== ndmRtkRequestSeq) return;
                    ndmRtkSessionId = null;
                    applyNdmRtkAnalysisResult(result, seq);
                }).fail(function(xhr, status) {
                    if (seq !== ndmRtkRequestSeq || status === "abort") return;
                    setNdmRtkLoading(false);
                    setNdmRtkBadge("Error", "pending");
                    setNdmRtkStatus(ndmAjaxFailMessage(xhr, status, analyzeUrl));
                });
            }).fail(function(err) {
                if (seq !== ndmRtkRequestSeq || (err && err.aborted)) return;
                setNdmRtkLoading(false);
                setNdmRtkBadge("Error", "pending");
                var failUrl = (err && err.url) || ndmApi("/rtk/session");
                setNdmRtkStatus(ndmAjaxFailMessage(err && err.xhr, err && err.status, failUrl));
            });
        }).fail(function(xhr, status) {
            if (seq !== ndmRtkRequestSeq || status === "abort") return;
            if (xhr && xhr.status === 404) {
                ndmRtkSessionUpload = false;
                refreshRtkLegacyFromDropzone(files, seq);
                return;
            }
            setNdmRtkLoading(false);
            setNdmRtkBadge("Error", "pending");
            setNdmRtkStatus(ndmAjaxFailMessage(xhr, status, ndmApi("/rtk/session")));
        });
    }

    function refreshRtkFromDropzone() {
        var files = (dz.files || []).filter(ndmIsImageFile);
        if (!ndmRtkEnabled) {
            setNdmRtkPanelVisible(false);
            if (!files.length) {
                clearNdmRtkState();
            } else {
                setNdmRtkPanelVisible(true);
                setNdmRtkBadge("Unavailable", "pending");
            }
            return;
        }

        setNdmRtkPanelVisible(true);
        if (app && app.uploading && app.uploading()) {
            return;
        }

        if (!files.length) {
            clearNdmRtkState();
            return;
        }

        abortNdmRtkWork();
        destroyNdmRtkSession();

        setNdmRtkBadge("Analyzing…", "busy");
        setNdmRtkLoading(true);

        var seq = ++ndmRtkRequestSeq;
        if (ndmRtkSessionUpload === false) {
            refreshRtkLegacyFromDropzone(files, seq);
            return;
        }
        refreshRtkSessionFromDropzone(files, seq);
    }

    function scheduleRtkFromDropzone() {
        clearTimeout(rtkMapTimer);
        rtkMapTimer = setTimeout(refreshRtkFromDropzone, 700);
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
            var key = ndmPhotoKey(r.file);
            if (hasGps && ndmDeselectedIds.has(key)) li.classList.add("excluded");

            var rtkRec = ndmRtkByFilename[r.file.name];
            if (rtkRec && rtkRec.quality) {
                var rtkClass = ndmRtkQualityClass(rtkRec.quality);
                if (rtkClass) li.classList.add(rtkClass);
            }

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

            var rtk = document.createElement("span");
            rtk.className = "rtk";
            if (rtkRec) {
                rtk.classList.add(rtkRec.quality === "PASS" ? "has-pass" : (rtkRec.quality === "WARN" ? "has-warn" : "has-fail"));
                rtk.textContent = ndmRtkLabelForRecord(rtkRec);
            } else if (ndmRtkEnabled && (dz.files || []).filter(ndmIsImageFile).length) {
                rtk.classList.add("missing");
                rtk.textContent = "RTK pending";
            }
            if (rtk.textContent) li.appendChild(rtk);

            if (hasGps) {
                var proc = document.createElement("span");
                proc.className = "proc " + (ndmDeselectedIds.has(key) ? "out" : "in");
                proc.textContent = ndmDeselectedIds.has(key) ? "Excluded from job" : "Included in job";
                li.appendChild(proc);
            }

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
        ndmEndPolygonDraw(false);
        revokeNdmGpsPreviewUrls();
        ndmGpsMarkers.clearLayers();
        ndmMarkersById = Object.create(null);
        ndmDeselectedIds.clear();
        ndmGpsPoints = !points.length ? [] : points.map(function(r) {
            return {
                key: ndmPhotoKey(r.file),
                file: r.file,
                lat: r.lat,
                lng: r.lng,
                _previewBlock: ""
            };
        });
        ndmSetDeselectMode(false);

        if (!ndmGpsPoints.length) {
            ndmGpsMap.setView(DEFAULT_GPS_VIEW.center, DEFAULT_GPS_VIEW.zoom);
            ndmUpdateDeselectToolbarButtons();
            renderNdmFileRows(ndmLastGpsResults);
            setTimeout(function() { if (ndmGpsMap) ndmGpsMap.invalidateSize(); }, 100);
            return;
        }

        ndmGpsPoints.forEach(function(p) {
            p._previewBlock = "";
            if (p.file && ndmIsImageFile(p.file) && ndmFileLikelyDisplayableInImgTag(p.file) && typeof URL !== "undefined" && URL.createObjectURL) {
                try {
                    var blobUrl = URL.createObjectURL(p.file);
                    ndmGpsPreviewUrls.push(blobUrl);
                    p._previewBlock =
                        "<div class=\"map-popup-preview-wrap\"><img class=\"map-popup-preview\" src=\"" +
                        blobUrl + "\" alt=\"Preview: " + ndmEscapeHtml(p.file.name) + "\"></div>";
                } catch (e) {
                    p._previewBlock = "";
                }
            } else if (p.file && ndmIsImageFile(p.file)) {
                p._previewBlock = "<p class=\"map-popup-preview-note\">Preview not shown for this format (open the file locally to view).</p>";
            }
        });

        var latlngs = ndmGpsPoints.map(function(p) { return [p.lat, p.lng]; });
        ndmGpsPoints.forEach(function(p) {
            var selected = !ndmDeselectedIds.has(p.key);
            var m = L.marker([p.lat, p.lng], { icon: ndmGpsMarkerIcon(selected) });
            m._photoKey = p.key;
            m._photoPoint = p;
            m.bindPopup(ndmGpsPopupFullHtml(p), { maxWidth: 320, className: "ndm-gps-popup" });
            m.on("click", function() {
                if (!ndmDeselectMode) return;
                m.closePopup();
                ndmToggleGpsDeselectKey(p.key);
            });
            ndmGpsMarkers.addLayer(m);
            ndmMarkersById[p.key] = m;
        });

        if (latlngs.length === 1) {
            ndmGpsMap.setView(latlngs[0], 17);
        } else {
            ndmGpsMap.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 18 });
        }
        ndmUpdateDeselectToolbarButtons();
        renderNdmFileRows(ndmLastGpsResults);
        setTimeout(function() { if (ndmGpsMap) ndmGpsMap.invalidateSize(); }, 100);
    }

    function refreshGpsFromDropzone() {
        initNdmGpsMap();
        var files = (dz.files || []).filter(ndmIsImageFile);
        if (!files.length) {
            ndmLastGpsResults = [];
            updateNdmGpsMap([]);
            renderNdmFileRows([]);
            setMapGpsStatus("Add images in the drop zone to read GPS from EXIF.", false);
            return;
        }
        setMapGpsStatus("Reading GPS from EXIF…", true);
        Promise.all(files.map(readGpsForNdmFile)).then(function(results) {
            ndmLastGpsResults = results;
            var withGps = results.filter(function(r) { return r.lat != null && r.lng != null; });
            updateNdmGpsMap(withGps);
            if (typeof exifr === "undefined") {
                setMapGpsStatus("GPS preview unavailable (exifr failed to load).", false);
            } else if (!withGps.length) {
                setMapGpsStatus("No GPS tags found in " + files.length + " image(s).", false);
            } else if (withGps.length < files.length) {
                setMapGpsStatus(withGps.length + " of " + files.length + " images have GPS — use the map tools to exclude any from the job.", false);
            } else {
                setMapGpsStatus(withGps.length + " images on the map. Toggle deselect mode to exclude photos by click or polygon.", false);
            }
        });
    }

    function scheduleGpsFromDropzone() {
        clearTimeout(gpsMapTimer);
        gpsMapTimer = setTimeout(refreshGpsFromDropzone, 220);
    }

    dz.on("processing", function(file){
        this.options.url = ndmApi("/task/new/upload/") + app.uuid() + ndmTokenQs();
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
        scheduleRtkFromDropzone();
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
        $.ajax(ndmApi("/task/new/commit/" + app.uuid()) + ndmTokenQs(), {
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
        scheduleRtkFromDropzone();
    })
    .on("removedfile", function(){
        scheduleGpsFromDropzone();
        scheduleRtkFromDropzone();
    });

    setTimeout(scheduleGpsFromDropzone, 400);

    $.get(ndmApi("/rtk/status") + ndmTokenQs(), ndmRtkAjaxOpts).done(function(st) {
        ndmRtkEnabled = !!(st && st.enabled && st.available);
        if (st && st.sessionUpload === false) {
            ndmRtkSessionUpload = false;
        } else if (st && st.sessionUpload === true) {
            ndmRtkSessionUpload = true;
        }
        setNdmRtkPanelVisible(ndmRtkEnabled);
        if (!ndmRtkEnabled && st && st.reason) {
            setNdmRtkStatus("RTK preview unavailable: " + st.reason);
        }
    }).fail(function(xhr, status) {
        if (xhr && xhr.status === 404) {
            ndmRtkSessionUpload = false;
        }
    }).always(function() {
        scheduleRtkFromDropzone();
    });

    app = new App();
    var appRoot = document.getElementById("app");
    if (appRoot) {
        ko.applyBindings(app, appRoot);
    }

    $.get(ndmApi("/auth/bootstrap")).done(function (d) {
        if (d.oauth && d.signedIn) {
            var bar = document.getElementById("ndmOAuthBar");
            if (bar) bar.hidden = false;
        }
        if (d.oauth && d.portalStagingEnvOrigin && d.portalSuperEnvOrigin) {
            var wrap = document.getElementById("ndmEnvSwitch");
            var st = document.getElementById("ndmEnvStaging");
            var su = document.getElementById("ndmEnvSuper");
            if (wrap && st && su) {
                function envSwitchHref(dest) {
                    var base = dest === "staging" ? d.portalStagingEnvOrigin : d.portalSuperEnvOrigin;
                    var targetO;
                    try {
                        targetO = new URL(base + "/").origin;
                    } catch (e0) {
                        return "#";
                    }
                    if (window.location.origin === targetO) {
                        try {
                            return new URL("/", window.location.origin + "/").href;
                        } catch (e1) {
                            return "/";
                        }
                    }
                    if (d.signedIn && d.crossSso) {
                        return "/auth/switch-site?dest=" + dest;
                    }
                    try {
                        return new URL("/login.html", targetO + "/").href;
                    } catch (e2) {
                        return "#";
                    }
                }
                st.href = envSwitchHref("staging");
                su.href = envSwitchHref("super");
                st.textContent = d.portalStagingEnvLabel || "dronemaps";
                su.textContent = d.portalSuperEnvLabel || "superdrone";
                var metaSt = document.getElementById("ndmEnvStagingTagline");
                var metaSu = document.getElementById("ndmEnvSuperTagline");
                if (metaSt && d.portalStagingEnvTagline) metaSt.textContent = d.portalStagingEnvTagline;
                if (metaSu && d.portalSuperEnvTagline) metaSu.textContent = d.portalSuperEnvTagline;
                var here = window.location.origin;
                try {
                    if (new URL(d.portalStagingEnvOrigin).origin === here) {
                        st.classList.add("ndm-env-switch__pill--active");
                    } else if (new URL(d.portalSuperEnvOrigin).origin === here) {
                        su.classList.add("ndm-env-switch__pill--active");
                    }
                } catch (e1) {}
                wrap.hidden = false;
            }
        }
        if (d.gcsUpload) {
            ndmGcsApplyStatus(d.gcsUpload);
        }
    });

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
        var url = ndmApi("/task/list") + ndmTokenQs();
        this.error = ko.observable("");
        this.listLoading = ko.observable(true);
        this.listLoadingSlow = ko.observable(false);
        this.tasks = ko.observableArray();

        var listSlowTimer = setTimeout(function() {
            if (self.listLoading()) self.listLoadingSlow(true);
        }, 280);

        $.ajax({ url: url, method: "GET", dataType: "json" })
            .done(function(tasksJson) {
                if (tasksJson.error){
                    self.error(tasksJson.error);
                }else{
                    for (var i in tasksJson){
                        self.tasks.push(new Task(tasksJson[i].uuid));
                    }
                }
            })
            .fail(function(xhr, textStatus) {
                self.error(ndmAjaxFailMessage(xhr, textStatus, url));
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
        var url = ndmApi("/task/" + this.uuid + "/info") + ndmTokenQs();
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
            .fail(function(xhr, textStatus) {
                self.info({ error: ndmAjaxFailMessage(xhr, textStatus, url) });
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
        location.href = ndmApi("/task/" + this.uuid + "/info") + ndmTokenQs();
    };
    Task.prototype.copyOutput = function(){
        var self = this;
        var url = ndmApi("/task/" + self.uuid + "/output");
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
        var url = ndmApi("/task/" + self.uuid + "/output");
            $.get(url, { token: token })
                .done(function(output) {
                    var wnd = window.open("about:blank", "", "_blank");
                    if (output.length === 0){
                        output = JSON.parse(localStorage.getItem(self.uuid + '_output') || []);
                    }
                    wnd.document.write(output.join("<br/>"));
                })
                .fail(function(xhr, textStatus) {
                    self.info({ error: ndmAjaxFailMessage(xhr, textStatus, url) });
                });
    };
    Task.prototype.viewOutput = function() {
        var self = this;

        function fetchOutput() {
            var url = ndmApi("/task/" + self.uuid + "/output");
            $.get(url, { line: -9, token: token })
                .done(function(output) {
                    if (output.length === 0){
                        output = JSON.parse(localStorage.getItem(self.uuid + '_output') || []);
                    }
                    self.output(output);
                })
                .fail(function(xhr, textStatus) {
                    self.info({ error: ndmAjaxFailMessage(xhr, textStatus, url) });
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
        var url = ndmApi("/task/remove") + ndmTokenQs();

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
                .fail(function(xhr, textStatus) {
                    self.info({ error: ndmAjaxFailMessage(xhr, textStatus, url) });
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
                .fail(function(xhr, textStatus) {
                    self.info({ error: ndmAjaxFailMessage(xhr, textStatus, url) });
                    self.stopRefreshingInfo();
                });
        };
    }
    Task.prototype.cancel = genApiCall(ndmApi("/task/cancel") + ndmTokenQs());
    Task.prototype.restart = genApiCall(ndmApi("/task/restart") + ndmTokenQs(), function(task) {
        task.resetOutput();
    });
    Task.prototype.downloadLink = function(){
        return ndmApi("/task/" + this.uuid + "/download/all.zip") + ndmTokenQs();
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

        if (!this.hasHelpDetail) {
            var bits = [];
            bits.push("OpenDroneMap option — " + (properties.name || ""));
            bits.push("Type: " + (properties.type || "string"));
            if (this.domainTooltipText) {
                var dt = this.domainTooltipText;
                if (dt.length > 320) dt = dt.slice(0, 317) + "…";
                bits.push("Domain / allowed values: " + dt);
            }
            if (this.defaultValue !== undefined && this.defaultValue !== null && String(this.defaultValue) !== "") {
                bits.push("Default in this form: " + String(this.defaultValue));
            }
            bits.push("Full CLI help comes from your ODM build when available.");
            helpStr = bits.join("\n");
        }
        this.helpDisplayText = helpStr;
        /* Native title tooltips: single line reads reliably (newlines look broken in many browsers). */
        this.helpTitleText = String(helpStr).replace(/\r?\n+/g, " ").replace(/\s{2,}/g, " ").trim();

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
        var optUrl = ndmApi("/options") + (token ? "?token=" + encodeURIComponent(token) + "&_=" : "?_=") + ts;
        var staticDefUrl = "/js/ndm-ui-defaults.json?_=" + ts;
        var apiDefUrl = ndmApi("/option-ui-defaults") + (token ? "?token=" + encodeURIComponent(token) + "&_=" : "?_=") + ts;

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
        /* No ortho-only preset; always keep raw uploads under images/ (optimize-disk-space off). */
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

    (function setupNdmAppNav() {
        var layout = document.getElementById("ndmAppLayout");
        var collapseBtn = document.getElementById("ndmSidebarCollapse");
        var navItems = document.querySelectorAll("[data-ndm-view]");
        var views = document.querySelectorAll(".ndm-view");
        if (!layout || !views.length) return;

        var sidebarKey = "ndmSidebarCollapsed";
        try {
            if (localStorage.getItem(sidebarKey) === "1") {
                layout.classList.add("ndm-sidebar--collapsed");
                if (collapseBtn) collapseBtn.setAttribute("aria-expanded", "false");
            }
        } catch (e0) { /* ignore */ }

        if (collapseBtn) {
            collapseBtn.addEventListener("click", function() {
                var collapsed = layout.classList.toggle("ndm-sidebar--collapsed");
                collapseBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
                try { localStorage.setItem(sidebarKey, collapsed ? "1" : "0"); } catch (e1) { /* ignore */ }
                setTimeout(function() {
                    if (ndmGpsMap) ndmGpsMap.invalidateSize();
                }, 220);
            });
        }

        function showView(name) {
            views.forEach(function(v) {
                var match = v.getAttribute("data-ndm-view") === name;
                v.hidden = !match;
            });
            document.querySelectorAll(".ndm-nav-item").forEach(function(btn) {
                var active = btn.getAttribute("data-ndm-view") === name;
                btn.classList.toggle("ndm-nav-item--active", active);
            });
            if (name === "home") {
                setTimeout(function() {
                    if (ndmGpsMap) ndmGpsMap.invalidateSize();
                }, 200);
            }
            if (name === "uploads" && typeof ndmGcsUploadOnView === "function") {
                ndmGcsUploadOnView();
            }
        }

        document.querySelectorAll(".ndm-nav-item[data-ndm-view]").forEach(function(btn) {
            btn.addEventListener("click", function() {
                showView(btn.getAttribute("data-ndm-view"));
            });
        });

        var hash = (location.hash || "").replace(/^#/, "");
        if (hash === "uploads") showView("uploads");
    })();

    var ndmGcsEnabled = false;
    var ndmGcsFiles = [];
    var ndmGcsProjectsCache = [];
    var ndmGcsProjectsCacheMeta = { key: "", fetchedAt: 0 };
    var ndmGcsProjectsFetch = null;
    var ndmGcsCacheKeyStr = "";
    var ndmGcsSuggestIndex = -1;
    var ndmGcsAjaxOpts = { xhrFields: { withCredentials: true } };
    var NDM_GCS_PROJECTS_CACHE_STORAGE = "ndmGcsProjectsCacheV1";
    var NDM_GCS_PROJECTS_CACHE_TTL_MS = 5 * 60 * 1000;
    var NDM_GCS_WARN_FILE_COUNT = 300;
    var NDM_GCS_MAX_INDIVIDUAL_FILES = 2500;
    var NDM_GCS_STALL_MS = 5 * 60 * 1000;

    function ndmGcsSetError(msg) {
        var el = document.getElementById("gcsUploadError");
        if (!el) return;
        if (msg) {
            el.textContent = msg;
            el.hidden = false;
        } else {
            el.textContent = "";
            el.hidden = true;
        }
    }

    function ndmGcsRenderFileList() {
        var list = document.getElementById("gcsUploadFileList");
        var startBtn = document.getElementById("gcsUploadStart");
        if (!list) return;
        list.innerHTML = "";
        ndmGcsFiles.forEach(function(item) {
            var li = document.createElement("li");
            var name = document.createElement("span");
            name.className = "name";
            name.textContent = item.relativePath || item.file.name;
            var meta = document.createElement("span");
            meta.className = "meta";
            meta.textContent = (item.file.size / (1024 * 1024)).toFixed(2) + " MB";
            var rm = document.createElement("button");
            rm.type = "button";
            rm.className = "btn-ghost";
            rm.textContent = "Remove";
            rm.addEventListener("click", function() {
                ndmGcsFiles = ndmGcsFiles.filter(function(x) { return x !== item; });
                ndmGcsRenderFileList();
            });
            li.appendChild(name);
            li.appendChild(meta);
            li.appendChild(rm);
            list.appendChild(li);
        });
        if (startBtn) {
            startBtn.disabled = !ndmGcsEnabled || !ndmGcsFiles.length || !(document.getElementById("gcsProjectName") || {}).value.trim();
        }
    }

    function ndmGcsNormalizeRelativePath(raw, fallbackName) {
        var s = String(raw || fallbackName || "file").replace(/\\/g, "/").replace(/^\/+/, "");
        var parts = s.split("/").filter(function(p) { return p && p !== "." && p !== ".."; });
        return parts.join("/") || fallbackName || "file";
    }

    function ndmGcsReadAllDirectoryEntries(reader) {
        return new Promise(function(resolve, reject) {
            var all = [];
            function readBatch() {
                reader.readEntries(function(entries) {
                    if (!entries.length) return resolve(all);
                    all = all.concat(Array.prototype.slice.call(entries));
                    readBatch();
                }, reject);
            }
            readBatch();
        });
    }

    function ndmGcsTraverseEntry(entry, prefix) {
        if (entry.isFile) {
            return new Promise(function(resolve, reject) {
                entry.file(function(file) {
                    resolve([{ file: file, relativePath: ndmGcsNormalizeRelativePath(prefix + file.name) }]);
                }, reject);
            });
        }
        if (entry.isDirectory) {
            var dirPrefix = prefix + entry.name + "/";
            return ndmGcsReadAllDirectoryEntries(entry.createReader()).then(function(entries) {
                return Promise.all(entries.map(function(e) {
                    return ndmGcsTraverseEntry(e, dirPrefix);
                })).then(function(chunks) {
                    return Array.prototype.concat.apply([], chunks);
                });
            });
        }
        return Promise.resolve([]);
    }

    function ndmGcsCollectDroppedItems(dataTransfer) {
        if (!dataTransfer) return Promise.resolve([]);

        var items = dataTransfer.items;
        if (items && items.length && items[0].webkitGetAsEntry) {
            var entries = [];
            for (var i = 0; i < items.length; i++) {
                var entry = items[i].webkitGetAsEntry();
                if (entry) entries.push(entry);
            }
            if (entries.length) {
                return Promise.all(entries.map(function(entry) {
                    return ndmGcsTraverseEntry(entry, "");
                })).then(function(chunks) {
                    return Array.prototype.concat.apply([], chunks);
                });
            }
        }

        return Promise.resolve(Array.prototype.map.call(dataTransfer.files || [], function(f) {
            return {
                file: f,
                relativePath: ndmGcsNormalizeRelativePath(f.webkitRelativePath || f.name)
            };
        }));
    }

    function ndmGcsAddFileItems(items) {
        var seen = Object.create(null);
        ndmGcsFiles.forEach(function(it) {
            seen[it.relativePath] = true;
        });
        (items || []).forEach(function(it) {
            if (!it || !it.file) return;
            var rel = ndmGcsNormalizeRelativePath(it.relativePath, it.file.name);
            if (seen[rel]) return;
            seen[rel] = true;
            ndmGcsFiles.push({ file: it.file, relativePath: rel });
        });
        ndmGcsRenderFileList();
    }

    function ndmGcsSetProjectStatus(text, kind) {
        var el = document.getElementById("gcsProjectStatus");
        if (!el) return;
        el.textContent = text || "";
        el.className = "file-meta ndm-gcs-project-status" + (kind ? " ndm-gcs-project-status--" + kind : "");
    }

    function ndmGcsHideSuggest() {
        var list = document.getElementById("gcsProjectSuggest");
        var input = document.getElementById("gcsProjectName");
        if (list) list.hidden = true;
        if (input) input.setAttribute("aria-expanded", "false");
        ndmGcsSuggestIndex = -1;
    }

    function ndmGcsShowSuggest() {
        var list = document.getElementById("gcsProjectSuggest");
        var input = document.getElementById("gcsProjectName");
        if (!list || !input || input.disabled) return;
        list.hidden = false;
        input.setAttribute("aria-expanded", "true");
    }

    function ndmGcsSelectProject(item) {
        var input = document.getElementById("gcsProjectName");
        if (!input || !item) return;
        input.value = item.displayName || item.name || "";
        ndmGcsHideSuggest();
        ndmGcsRenderFileList();
        ndmGcsUpdateProjectUriPreview();
    }

    function ndmGcsUpdateProjectUriPreview() {
        var uriEl = document.getElementById("gcsProjectUri");
        var input = document.getElementById("gcsProjectName");
        if (!uriEl || !input) return;
        var val = input.value.trim();
        if (!val || !ndmGcsEnabled) {
            uriEl.hidden = true;
            return;
        }
        uriEl.hidden = false;
        uriEl.textContent = "Will upload under project: " + val.replace(/\s+/g, "_").substring(0, 100);
    }

    function ndmGcsFilterProjects(query) {
        var q = String(query || "").trim().toLowerCase();
        if (!q) return ndmGcsProjectsCache.slice(0, 50);
        return ndmGcsProjectsCache.filter(function(p) {
            return (p.name && p.name.toLowerCase().indexOf(q) !== -1) ||
                (p.displayName && p.displayName.toLowerCase().indexOf(q) !== -1);
        }).slice(0, 50);
    }

    function ndmGcsRenderProjectSuggest(query) {
        var list = document.getElementById("gcsProjectSuggest");
        var input = document.getElementById("gcsProjectName");
        if (!list || !input) return;

        var matches = ndmGcsFilterProjects(query);
        list.innerHTML = "";
        ndmGcsSuggestIndex = -1;

        if (!ndmGcsEnabled) {
            list.innerHTML = "<li class=\"ndm-gcs-project-suggest__empty\">Cloud storage is not available on this server.</li>";
            ndmGcsShowSuggest();
            return;
        }

        if (!matches.length) {
            var empty = document.createElement("li");
            empty.className = "ndm-gcs-project-suggest__empty";
            empty.textContent = query
                ? "No matching projects — press Enter to use \"" + query + "\" as a new title."
                : (ndmGcsProjectsCache.length
                    ? "Type to search " + ndmGcsProjectsCache.length + " project(s)."
                    : "No projects in bucket yet — type a new title.");
            list.appendChild(empty);
            ndmGcsShowSuggest();
            return;
        }

        matches.forEach(function(item, i) {
            var li = document.createElement("li");
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "ndm-gcs-project-suggest__item";
            btn.setAttribute("role", "option");
            btn.setAttribute("data-index", String(i));
            var title = document.createElement("span");
            title.textContent = item.displayName || item.name || "";
            var meta = document.createElement("span");
            meta.className = "ndm-gcs-project-suggest__meta";
            meta.textContent = item.name || "";
            btn.appendChild(title);
            btn.appendChild(meta);
            btn.addEventListener("mousedown", function(e) {
                e.preventDefault();
                ndmGcsSelectProject(item);
            });
            li.appendChild(btn);
            list.appendChild(li);
        });
        ndmGcsShowSuggest();
    }

    function ndmGcsProjectsCacheKey(st) {
        if (st && st.bucket) {
            return String(st.bucket) + "|" + String(st.prefix || "");
        }
        return ndmGcsCacheKeyStr || "";
    }

    function ndmGcsProjectsCacheFresh(cacheKey) {
        if (!cacheKey || ndmGcsProjectsCacheMeta.key !== cacheKey) return false;
        if (!ndmGcsProjectsCache.length && ndmGcsProjectsCacheMeta.fetchedAt === 0) return false;
        return Date.now() - ndmGcsProjectsCacheMeta.fetchedAt < NDM_GCS_PROJECTS_CACHE_TTL_MS;
    }

    function ndmGcsReadProjectsSessionCache(cacheKey) {
        try {
            var raw = sessionStorage.getItem(NDM_GCS_PROJECTS_CACHE_STORAGE);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (!parsed || parsed.key !== cacheKey) return null;
            if (Date.now() - parsed.fetchedAt > NDM_GCS_PROJECTS_CACHE_TTL_MS) return null;
            return parsed;
        } catch (e) {
            return null;
        }
    }

    function ndmGcsWriteProjectsSessionCache(cacheKey, projects) {
        try {
            sessionStorage.setItem(NDM_GCS_PROJECTS_CACHE_STORAGE, JSON.stringify({
                key: cacheKey,
                fetchedAt: Date.now(),
                projects: projects || []
            }));
        } catch (e) { /* quota / private mode */ }
    }

    function ndmGcsClearProjectsCache() {
        ndmGcsProjectsCache = [];
        ndmGcsProjectsCacheMeta = { key: "", fetchedAt: 0 };
        try { sessionStorage.removeItem(NDM_GCS_PROJECTS_CACHE_STORAGE); } catch (e) { /* ignore */ }
    }

    function ndmGcsStoreProjectsCache(projects, cacheKey) {
        ndmGcsProjectsCache = projects || [];
        ndmGcsProjectsCacheMeta = { key: cacheKey, fetchedAt: Date.now() };
        ndmGcsWriteProjectsSessionCache(cacheKey, ndmGcsProjectsCache);
    }

    function ndmGcsSetProjectStatusFromCache(fromSession) {
        var suffix = fromSession ? " (loaded from cache)" : " (cached)";
        ndmGcsSetProjectStatus(
            ndmGcsProjectsCache.length
                ? ndmGcsProjectsCache.length + " project(s) — type to search or pick from the list." + suffix
                : "No existing projects found — type a new title to create one." + suffix,
            ""
        );
    }

    function ndmGcsMergeProjectIntoCache(projectName, sanitizedName) {
        if (!sanitizedName) return;
        var displayName = projectName || sanitizedName.replace(/_/g, " ");
        var exists = ndmGcsProjectsCache.some(function(p) {
            return p.name === sanitizedName;
        });
        if (!exists) {
            ndmGcsProjectsCache.push({ name: sanitizedName, displayName: displayName });
            ndmGcsProjectsCache.sort(function(a, b) {
                return (a.displayName || a.name).localeCompare(b.displayName || b.name);
            });
            if (ndmGcsProjectsCacheMeta.key) {
                ndmGcsWriteProjectsSessionCache(ndmGcsProjectsCacheMeta.key, ndmGcsProjectsCache);
            }
        }
    }

    function ndmGcsSetupHintHtml(st) {
        var base = (st && st.reason) ? st.reason : "GCS is not connected on this server.";
        var local = "";
        if (typeof location !== "undefined") {
            var host = location.hostname;
            if (host === "localhost" || host === "127.0.0.1") {
                local = " Local dev: set GCS_BUCKET in .env, run gcloud auth application-default login, then " +
                    "docker compose -f docker-compose.dev.yml -f docker-compose.gcs-adc.yml up -d --force-recreate " +
                    "(recreate after every gcloud login — the container only reads ADC at startup). " +
                    "If you see invalid_rapt / reauth errors, use a service-account JSON key with docker-compose.gcs.yml instead.";
            }
        }
        return base + local;
    }

    /** Load project list; uses memory + sessionStorage cache unless forceRefresh. */
    function ndmGcsLoadProjects(forceRefresh) {
        if (!ndmGcsEnabled) {
            return $.when();
        }

        var cacheKey = ndmGcsCacheKeyStr;
        var input = document.getElementById("gcsProjectName");
        var query = input ? input.value : "";

        if (!forceRefresh && ndmGcsProjectsCacheFresh(cacheKey)) {
            ndmGcsSetProjectStatusFromCache(false);
            ndmGcsRenderProjectSuggest(query);
            return $.when();
        }

        if (!forceRefresh) {
            var stored = ndmGcsReadProjectsSessionCache(cacheKey);
            if (stored && stored.projects) {
                ndmGcsStoreProjectsCache(stored.projects, cacheKey);
                ndmGcsProjectsCacheMeta.fetchedAt = stored.fetchedAt;
                ndmGcsSetProjectStatusFromCache(true);
                ndmGcsRenderProjectSuggest(query);
                return $.when();
            }
        }

        if (ndmGcsProjectsFetch) {
            return ndmGcsProjectsFetch.then(function() {
                ndmGcsRenderProjectSuggest(query);
            });
        }

        ndmGcsSetProjectStatus("Loading projects from bucket…", "loading");
        var url = ndmApi("/gcs/projects") + ndmTokenQs();

        ndmGcsProjectsFetch = $.get(url, ndmGcsAjaxOpts).done(function(data) {
            if (data && data.error) {
                ndmGcsClearProjectsCache();
                ndmGcsSetProjectStatus(data.error, "error");
                return;
            }
            var projects = (data && data.projects) ? data.projects : [];
            if (data && data.bucket) {
                ndmGcsCacheKeyStr = String(data.bucket) + "|" + String(data.prefix || "");
                cacheKey = ndmGcsCacheKeyStr;
            }
            ndmGcsStoreProjectsCache(projects, cacheKey);
            ndmGcsSetProjectStatus(
                ndmGcsProjectsCache.length
                    ? ndmGcsProjectsCache.length + " project(s) in bucket — type to search or pick from the list."
                    : "No existing projects found — type a new title to create one.",
                ""
            );
        }).fail(function(xhr, status) {
            if (!ndmGcsProjectsCacheFresh(cacheKey)) {
                ndmGcsClearProjectsCache();
            }
            ndmGcsSetProjectStatus(ndmAjaxFailMessage(xhr, status, ndmApi("/gcs/projects")), "error");
        }).always(function() {
            ndmGcsProjectsFetch = null;
            ndmGcsRenderProjectSuggest(input ? input.value : "");
        });

        return ndmGcsProjectsFetch;
    }

    function ndmGcsRefreshProjects() {
        return ndmGcsLoadProjects(true);
    }

    function ndmGcsApplyStatus(st) {
        var hint = document.getElementById("ndmGcsUploadHint");
        var view = document.getElementById("ndmViewUploads");
        var nameEl = document.getElementById("gcsProjectName");
        var refreshBtn = document.getElementById("gcsRefreshProjects");
        ndmGcsEnabled = !!(st && st.enabled);
        if (hint) {
            if (!ndmGcsEnabled) {
                hint.textContent = (st && st.reason) || "GCS uploads are not configured on this server.";
            } else {
                hint.innerHTML = "Destination bucket: <strong>" + (st.bucket || "") + "</strong>" +
                    (st.prefix ? " · prefix: <code>" + st.prefix + "/</code>" : "");
            }
        }
        if (view) view.setAttribute("aria-disabled", ndmGcsEnabled ? "false" : "true");
        if (nameEl) {
            nameEl.disabled = false;
            nameEl.placeholder = ndmGcsEnabled
                ? "Search or type project title…"
                : "Connect GCS to search existing projects (see note below)";
        }
        if (refreshBtn) refreshBtn.disabled = !ndmGcsEnabled;
        if (!ndmGcsEnabled) {
            ndmGcsHideSuggest();
            ndmGcsClearProjectsCache();
            if (hint) {
                hint.innerHTML = ndmGcsSetupHintHtml(st);
            }
            ndmGcsSetProjectStatus("Project search requires GCS. Upload button stays disabled until connected.", "error");
        } else {
            ndmGcsCacheKeyStr = ndmGcsProjectsCacheKey(st);
            ndmGcsLoadProjects(false);
        }
        ndmGcsRenderFileList();
    }

    function ndmGcsUploadOnView() {
        ndmGcsLoadProjects(false);
        var nameEl = document.getElementById("gcsProjectName");
        if (nameEl && !nameEl.disabled) {
            nameEl.focus();
            ndmGcsRenderProjectSuggest(nameEl.value || "");
        }
    }

    function ndmGcsLogLine(text, kind) {
        var log = document.getElementById("gcsUploadLog");
        if (!log) return;
        var li = document.createElement("li");
        if (kind) li.className = "ndm-gcs-log--" + kind;
        li.textContent = text;
        log.appendChild(li);
        log.scrollTop = log.scrollHeight;
    }

    function ndmGcsSetProgress(pct, label, indeterminate) {
        var wrap = document.getElementById("gcsUploadProgress");
        var bar = document.getElementById("gcsUploadProgressBar");
        var lbl = document.getElementById("gcsUploadProgressLabel");
        if (wrap) {
            wrap.hidden = false;
            wrap.classList.toggle("ndm-gcs-progress--busy", !!indeterminate);
        }
        if (bar) {
            bar.classList.toggle("ndm-gcs-progress__bar--indeterminate", !!indeterminate);
            if (!indeterminate) {
                bar.style.width = pct + "%";
                bar.textContent = Math.round(pct) + "%";
            } else {
                bar.style.width = "35%";
                bar.textContent = "…";
            }
        }
        if (lbl) lbl.textContent = label || "";
    }

    function ndmGcsFormatElapsed(seconds) {
        var s = Math.max(0, Math.floor(seconds || 0));
        var mins = Math.floor(s / 60);
        var rem = s % 60;
        if (mins > 0) return mins + "m " + rem + "s";
        return rem + "s";
    }

    function ndmGcsPollCommitProgress(uploadId) {
        var def = $.Deferred();
        var started = Date.now();
        var lastLogged = 0;

        function poll() {
            $.get(ndmApi("/gcs/upload/" + uploadId + "/progress") + ndmTokenQs(), ndmGcsAjaxOpts)
                .done(function(p) {
                    if (p && p.done) {
                        if (p.error) {
                            def.reject(p.error);
                            return;
                        }
                        def.resolve(p);
                        return;
                    }
                    var total = (p && p.filesTotal) || 0;
                    var done = (p && p.filesCompleted) || 0;
                    var pct = total > 0 ? 50 + Math.round((done / total) * 50) : 52;
                    var elapsed = ndmGcsFormatElapsed((Date.now() - started) / 1000);
                    var label = total > 0
                        ? "Step 2/2 — Uploading to Google Cloud: " + done + " / " + total + " (" + elapsed + ")"
                        : "Step 2/2 — Uploading to Google Cloud… (" + elapsed + ") — large folders can take several minutes";
                    if (p && p.currentFile) {
                        var short = p.currentFile;
                        if (short.length > 48) short = "…" + short.slice(-45);
                        label += " — " + short;
                    }
                    ndmGcsSetProgress(pct, label, total === 0);
                    if (done > 0 && (done - lastLogged >= 10 || done === total)) {
                        ndmGcsLogLine("GCS upload: " + done + "/" + total + (p.currentFile ? " — " + p.currentFile : ""), "ok");
                        lastLogged = done;
                    }
                    setTimeout(poll, 2000);
                })
                .fail(function() {
                    setTimeout(poll, 3000);
                });
        }

        poll();
        return def.promise();
    }

    function ndmGcsUploadOneFile(uploadId, item, attempt) {
        attempt = attempt || 0;
        var def = $.Deferred();
        var fd = new FormData();
        fd.append("file", item.file, item.file.name);
        fd.append("relativePath", item.relativePath || item.file.name);
        var sizeMb = item.file.size / (1024 * 1024);
        var timeoutMs = sizeMb > 100 ? 3600000 : sizeMb > 25 ? 1800000 : 600000;
        var jqXhr = $.ajax($.extend({
            url: ndmApi("/gcs/upload/" + uploadId + "/file") + ndmTokenQs(),
            type: "POST",
            data: fd,
            processData: false,
            contentType: false,
            timeout: timeoutMs
        }, ndmGcsAjaxOpts));
        jqXhr.done(function(res) {
            if (res && res.error) def.reject(res.error);
            else def.resolve(res, jqXhr);
        }).fail(function(xhr, status) {
            if (attempt < 2 && status !== "abort") {
                ndmGcsUploadOneFile(uploadId, item, attempt + 1).then(def.resolve, def.reject);
            } else {
                var label = item.relativePath || item.file.name;
                def.reject(ndmAjaxFailMessage(xhr, status, ndmApi("/gcs/upload/" + uploadId + "/file")) +
                    " (" + label + ")");
            }
        });
        return def.promise();
    }

    function ndmGcsCommitUpload(uploadId) {
        return $.ajax($.extend({
            url: ndmApi("/gcs/upload/" + uploadId + "/commit") + ndmTokenQs(),
            type: "POST",
            timeout: 0
        }, ndmGcsAjaxOpts));
    }

    function ndmGcsStageFilesParallel(uploadId, items, onProgress) {
        var def = $.Deferred();
        var queue = items.slice().sort(function(a, b) { return a.file.size - b.file.size; });
        var uploaded = 0;
        var idx = 0;
        var active = 0;
        var activeLarge = 0;
        var failed = null;
        var inFlight = [];
        var lastProgressAt = Date.now();
        var maxConcurrent = queue.length > 500 ? 6 : 4;
        var largeThreshold = 25 * 1024 * 1024;
        var maxLargeConcurrent = 2;

        function notifyProgress(item, res) {
            if (onProgress) onProgress(uploaded, queue.length, item, res, inFlight.slice());
        }

        function finishOne(capturedItem, res) {
            active--;
            if (capturedItem.file.size > largeThreshold) activeLarge--;
            for (var i = 0; i < inFlight.length; i++) {
                if (inFlight[i].item === capturedItem) {
                    inFlight.splice(i, 1);
                    break;
                }
            }
            uploaded++;
            lastProgressAt = Date.now();
            notifyProgress(capturedItem, res);
            if (uploaded >= queue.length && active === 0) {
                clearInterval(stallTimer);
                clearInterval(heartbeatTimer);
                def.resolve();
            } else {
                pump();
            }
        }

        function failOne(err) {
            failed = err;
            clearInterval(stallTimer);
            clearInterval(heartbeatTimer);
            if (def.state() === "pending") def.reject(failed);
        }

        function pump() {
            if (failed || def.state() !== "pending") return;
            while (active < maxConcurrent && idx < queue.length) {
                var next = queue[idx];
                var isLarge = next.file.size > largeThreshold;
                if (isLarge && activeLarge >= maxLargeConcurrent) break;
                idx++;
                active++;
                if (isLarge) activeLarge++;
                (function(capturedItem) {
                    var entry = { item: capturedItem, startedAt: Date.now() };
                    inFlight.push(entry);
                    var promise = ndmGcsUploadOneFile(uploadId, capturedItem);
                    promise.done(function(res) {
                        finishOne(capturedItem, res);
                    }).fail(function(err) {
                        active--;
                        if (capturedItem.file.size > largeThreshold) activeLarge--;
                        for (var j = 0; j < inFlight.length; j++) {
                            if (inFlight[j].item === capturedItem) {
                                inFlight.splice(j, 1);
                                break;
                            }
                        }
                        if (!failed) failOne(err);
                    });
                })(next);
            }
            if (active === 0 && uploaded >= queue.length && !failed) {
                clearInterval(stallTimer);
                clearInterval(heartbeatTimer);
                def.resolve();
            }
        }

        var stallTimer = setInterval(function() {
            if (def.state() !== "pending") return;
            var stalledMs = Date.now() - lastProgressAt;
            var remaining = queue.length - uploaded;
            var stallLimit = remaining <= 10 ? 3 * 60 * 1000 : NDM_GCS_STALL_MS;
            if (stalledMs > stallLimit) {
                var names = inFlight.map(function(f) {
                    return f.item.relativePath || f.item.file.name;
                }).slice(0, 5);
                var hint = names.length ? " Still waiting on: " + names.join(", ") + (inFlight.length > 5 ? "…" : "") + "." : "";
                failOne(
                    "No progress for " + Math.round(stallLimit / 60000) + " minutes (" +
                    uploaded + " / " + queue.length + " sent)." + hint +
                    " Large point-cloud tiles (.laz) upload slowly — zip the folder and upload one .zip instead."
                );
            }
        }, 15000);

        var heartbeatTimer = setInterval(function() {
            if (def.state() !== "pending" || !inFlight.length) return;
            notifyProgress(null, null);
        }, 3000);

        if (!queue.length) {
            def.resolve();
        } else {
            pump();
        }
        return def.promise();
    }

    function ndmGcsRunUpload() {
        var projectName = (document.getElementById("gcsProjectName") || {}).value.trim();
        if (!projectName) {
            ndmGcsSetError("Enter a project title.");
            return;
        }
        if (!ndmGcsFiles.length) {
            ndmGcsSetError("Add at least one file.");
            return;
        }
        var fileCount = ndmGcsFiles.length;
        if (fileCount > NDM_GCS_MAX_INDIVIDUAL_FILES) {
            ndmGcsSetError(
                "This selection has " + fileCount + " files. Uploading each file separately is not reliable at this scale " +
                "(folders like entwine/ept-data contain thousands of tiny tiles). " +
                "Zip the project folder on your computer, then upload that single .zip file here."
            );
            return;
        }
        if (fileCount > NDM_GCS_WARN_FILE_COUNT) {
            var ok = window.confirm(
                "This selection has " + fileCount + " files. Step 1 sends each file to the server separately and can take hours or fail.\n\n" +
                "Recommended: zip the folder and upload one .zip file instead.\n\n" +
                "Continue with " + fileCount + " individual file uploads anyway?"
            );
            if (!ok) return;
        }
        ndmGcsSetError("");
        var startBtn = document.getElementById("gcsUploadStart");
        var clearBtn = document.getElementById("gcsUploadClear");
        if (startBtn) startBtn.disabled = true;
        if (clearBtn) clearBtn.disabled = true;

        var log = document.getElementById("gcsUploadLog");
        if (log) log.innerHTML = "";
        ndmGcsSetProgress(0, "Starting upload session…");

        $.ajax($.extend({
            url: ndmApi("/gcs/upload/init") + ndmTokenQs(),
            type: "POST",
            contentType: "application/json",
            data: JSON.stringify({ projectName: projectName })
        }, ndmGcsAjaxOpts)).done(function(session) {
            if (session.error) {
                ndmGcsSetError(session.error);
                if (startBtn) startBtn.disabled = false;
                if (clearBtn) clearBtn.disabled = false;
                return;
            }

            var uriEl = document.getElementById("gcsProjectUri");
            if (uriEl) {
                uriEl.hidden = false;
                uriEl.textContent = "Target: " + (session.gcsUri || "");
            }

            var uploadId = session.uploadId;
            var total = ndmGcsFiles.length;

            ndmGcsStageFilesParallel(uploadId, ndmGcsFiles, function(done, tot, item, res, inFlight) {
                var phasePct = tot > 0 ? Math.round((done / tot) * 45) : 0;
                var inProgress = (inFlight && inFlight.length) || 0;
                var label = "Step 1/2 — Sending to server: " + done + " / " + tot;
                if (inProgress) {
                    label += " (" + inProgress + " in progress";
                    var big = inFlight.filter(function(f) { return f.item.file.size > 25 * 1024 * 1024; });
                    if (big.length) {
                        var name = big[0].item.relativePath || big[0].item.file.name;
                        if (name.length > 40) name = "…" + name.slice(-37);
                        label += ", large: " + name;
                    }
                    label += ")";
                }
                ndmGcsSetProgress(phasePct, label);
                if (res && res.extracted) {
                    if (done === 1 || done === tot || done % 25 === 0) {
                        ndmGcsLogLine((item.relativePath || item.file.name) + " → ZIP extracted on server", "ok");
                    }
                } else if (item && (done === 1 || done === tot || done % 25 === 0)) {
                    ndmGcsLogLine("Server received " + done + " / " + tot + " files (not in GCS yet)", "ok");
                } else if (!item && inProgress && done > 0 && (done === tot - inProgress || done % 25 === 0)) {
                    ndmGcsLogLine("Still sending " + inProgress + " file(s) to server…", "ok");
                }
            }).done(function() {
                ndmGcsSetProgress(48, "Step 1/2 complete — starting upload to Google Cloud…");
                ndmGcsLogLine("All files on server. Uploading folder structure to GCS…", "ok");
                return ndmGcsCommitUpload(uploadId);
            }).done(function(start) {
                if (start && start.error) {
                    return $.Deferred().reject(start.error).promise();
                }
                var n = (start && start.filesTotal) || "?";
                ndmGcsLogLine("Step 2/2 — copying " + n + " file(s) to gs://… (this can take a while for large folders)", "ok");
                return ndmGcsPollCommitProgress(uploadId);
            }).done(function(commit) {
                ndmGcsSetProgress(100, "Done — " + (commit.filesUploaded || 0) + " file(s) in Google Cloud", false);
                ndmGcsLogLine("Complete: " + (commit.filesUploaded || 0) + " object(s) at " + (commit.gcsUri || ""), "ok");
                ndmGcsMergeProjectIntoCache(session.projectName, session.sanitizedName);
                ndmGcsSetProjectStatusFromCache(false);
            }).fail(function(err) {
                if (err) ndmGcsSetError(String(err));
            }).always(function() {
                var wrap = document.getElementById("gcsUploadProgress");
                if (wrap) wrap.classList.remove("ndm-gcs-progress--busy");
                var bar = document.getElementById("gcsUploadProgressBar");
                if (bar) bar.classList.remove("ndm-gcs-progress__bar--indeterminate");
                $.ajax($.extend({
                    url: ndmApi("/gcs/upload/" + uploadId) + ndmTokenQs(),
                    type: "DELETE"
                }, ndmGcsAjaxOpts));
                if (startBtn) startBtn.disabled = !ndmGcsEnabled || !ndmGcsFiles.length;
                if (clearBtn) clearBtn.disabled = false;
            });
        }).fail(function(xhr, status) {
            ndmGcsSetError(ndmAjaxFailMessage(xhr, status, ndmApi("/gcs/upload/init")));
            if (startBtn) startBtn.disabled = false;
            if (clearBtn) clearBtn.disabled = false;
        });
    }

    (function setupNdmGcsUpload() {
        var drop = document.getElementById("gcsUploadDropzone");
        var input = document.getElementById("gcsUploadInput");
        var folderInput = document.getElementById("gcsUploadFolderInput");
        var chooseFolderBtn = document.getElementById("gcsChooseFolder");
        var nameEl = document.getElementById("gcsProjectName");
        var startBtn = document.getElementById("gcsUploadStart");
        var clearBtn = document.getElementById("gcsUploadClear");
        var refreshBtn = document.getElementById("gcsRefreshProjects");
        if (!drop || !input) return;

        input.addEventListener("change", function() {
            ndmGcsAddFileItems(Array.prototype.map.call(input.files || [], function(f) {
                return { file: f, relativePath: f.name };
            }));
            input.value = "";
        });

        if (folderInput) {
            folderInput.addEventListener("change", function() {
                ndmGcsAddFileItems(Array.prototype.map.call(folderInput.files || [], function(f) {
                    return {
                        file: f,
                        relativePath: ndmGcsNormalizeRelativePath(f.webkitRelativePath || f.name)
                    };
                }));
                folderInput.value = "";
            });
        }

        if (chooseFolderBtn && folderInput) {
            chooseFolderBtn.addEventListener("click", function(e) {
                e.preventDefault();
                e.stopPropagation();
                folderInput.click();
            });
        }

        drop.addEventListener("dragover", function(e) {
            e.preventDefault();
            drop.classList.add("ndm-gcs-dropzone--drag");
        });
        drop.addEventListener("dragleave", function() {
            drop.classList.remove("ndm-gcs-dropzone--drag");
        });
        drop.addEventListener("drop", function(e) {
            e.preventDefault();
            drop.classList.remove("ndm-gcs-dropzone--drag");
            ndmGcsCollectDroppedItems(e.dataTransfer).then(function(items) {
                ndmGcsAddFileItems(items);
            }).catch(function() {
                ndmGcsSetError("Could not read dropped folder.");
            });
        });

        if (nameEl) {
            nameEl.addEventListener("input", function() {
                ndmGcsRenderFileList();
                ndmGcsUpdateProjectUriPreview();
                ndmGcsRenderProjectSuggest(nameEl.value);
            });
            nameEl.addEventListener("focus", function() {
                ndmGcsLoadProjects(false).always(function() {
                    ndmGcsRenderProjectSuggest(nameEl.value);
                });
            });
            nameEl.addEventListener("keydown", function(e) {
                var list = document.getElementById("gcsProjectSuggest");
                if (!list || list.hidden) return;
                var items = list.querySelectorAll(".ndm-gcs-project-suggest__item");
                if (!items.length) return;
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    ndmGcsSuggestIndex = Math.min(ndmGcsSuggestIndex + 1, items.length - 1);
                } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    ndmGcsSuggestIndex = Math.max(ndmGcsSuggestIndex - 1, 0);
                } else if (e.key === "Enter" && ndmGcsSuggestIndex >= 0) {
                    e.preventDefault();
                    var picked = ndmGcsFilterProjects(nameEl.value)[ndmGcsSuggestIndex];
                    if (picked) ndmGcsSelectProject(picked);
                    return;
                } else if (e.key === "Escape") {
                    ndmGcsHideSuggest();
                    return;
                } else {
                    return;
                }
                items.forEach(function(el, i) {
                    el.classList.toggle("ndm-gcs-project-suggest__item--active", i === ndmGcsSuggestIndex);
                });
                if (ndmGcsSuggestIndex >= 0) items[ndmGcsSuggestIndex].scrollIntoView({ block: "nearest" });
            });
        }

        document.addEventListener("click", function(e) {
            var field = document.querySelector(".ndm-gcs-project-field");
            if (field && !field.contains(e.target)) {
                ndmGcsHideSuggest();
            }
        });

        if (startBtn) startBtn.addEventListener("click", ndmGcsRunUpload);
        if (clearBtn) {
            clearBtn.addEventListener("click", function() {
                ndmGcsFiles = [];
                ndmGcsRenderFileList();
                ndmGcsSetError("");
            });
        }
        if (refreshBtn) refreshBtn.addEventListener("click", ndmGcsRefreshProjects);

        $.get(ndmApi("/gcs/upload/status") + ndmTokenQs(), ndmGcsAjaxOpts).done(ndmGcsApplyStatus).fail(function() {
            ndmGcsApplyStatus({ enabled: false, reason: "Could not reach GCS upload API." });
        });
    })();
});