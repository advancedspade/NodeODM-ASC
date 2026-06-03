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
                    try {
                        localStorage.setItem(self.uuid + '_output', JSON.stringify(output));
                    } catch (e) {
                        console.warn("Cannot cache output for " + self.uuid + ": " + e.message);
                    }
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
    var ndmGcsAjaxOpts = {
        xhrFields: { withCredentials: true },
        cache: false,
        headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" }
    };
    var NDM_GCS_PROJECTS_CACHE_STORAGE = "ndmGcsProjectsCacheV1";
    var NDM_GCS_PROJECTS_CACHE_TTL_MS = 5 * 60 * 1000;
    var NDM_GCS_MAX_INDIVIDUAL_FILES = 2500;
    var NDM_GCS_STALL_MS = 5 * 60 * 1000;
    var NDM_GCS_FILE_LIST_PREVIEW = 30;
    var ndmGcsDirectUpload = false;
    var ndmGcsUploadStartedAt = 0;
    var ndmGcsUploadElapsedTimer = null;

    function ndmGcsIsRemoteHost() {
        if (typeof location === "undefined") return true;
        var h = location.hostname;
        return h !== "localhost" && h !== "127.0.0.1";
    }

    function ndmGcsFileStallBudgetMs(item) {
        var sizeMb = (item && item.file ? item.file.size : 0) / (1024 * 1024);
        var mult = ndmGcsIsRemoteHost() ? 2 : 1;
        if (sizeMb > 500) return 90 * 60 * 1000 * mult;
        if (sizeMb > 100) return 45 * 60 * 1000 * mult;
        if (sizeMb > 25) return 20 * 60 * 1000 * mult;
        return 10 * 60 * 1000;
    }

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
        var total = ndmGcsFiles.length;
        var totalBytes = 0;
        ndmGcsFiles.forEach(function(item) { totalBytes += item.file.size; });
        var preview = total > NDM_GCS_FILE_LIST_PREVIEW
            ? ndmGcsFiles.slice(0, NDM_GCS_FILE_LIST_PREVIEW)
            : ndmGcsFiles;

        if (total > NDM_GCS_FILE_LIST_PREVIEW) {
            var summary = document.createElement("li");
            summary.className = "ndm-gcs-file-list__summary";
            summary.textContent = total + " file(s) selected (" +
                (totalBytes / (1024 * 1024 * 1024)).toFixed(2) + " GB total) — showing first " +
                NDM_GCS_FILE_LIST_PREVIEW;
            list.appendChild(summary);
        }

        preview.forEach(function(item) {
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
        ndmGcsSetError("");
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
                    : "No projects yet — type a new title.");
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
        if (st && st.enabled) {
            return "gcs-enabled";
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

        ndmGcsSetProjectStatus("Loading projects…", "loading");
        var url = ndmApi("/gcs/projects") + ndmTokenQs();

        ndmGcsProjectsFetch = $.get(url, ndmGcsAjaxOpts).done(function(data) {
            if (data && data.error) {
                ndmGcsClearProjectsCache();
                ndmGcsSetProjectStatus(data.error, "error");
                return;
            }
            var projects = (data && data.projects) ? data.projects : [];
            if (data && data.projects) {
                ndmGcsCacheKeyStr = "gcs-enabled";
                cacheKey = ndmGcsCacheKeyStr;
            }
            ndmGcsStoreProjectsCache(projects, cacheKey);
            ndmGcsSetProjectStatus(
                ndmGcsProjectsCache.length
                    ? ndmGcsProjectsCache.length + " project(s) available — type to search or pick from the list."
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
        var view = document.getElementById("ndmViewUploads");
        var nameEl = document.getElementById("gcsProjectName");
        var refreshBtn = document.getElementById("gcsRefreshProjects");
        ndmGcsEnabled = !!(st && st.enabled);
        ndmGcsDirectUpload = !!(st && st.directUpload);
        if (view) view.setAttribute("aria-disabled", ndmGcsEnabled ? "false" : "true");
        if (nameEl) {
            nameEl.disabled = false;
            nameEl.placeholder = ndmGcsEnabled
                ? "Search or type project title…"
                : "Cloud storage unavailable on this server";
        }
        if (refreshBtn) refreshBtn.disabled = !ndmGcsEnabled;
        if (!ndmGcsEnabled) {
            ndmGcsHideSuggest();
            ndmGcsClearProjectsCache();
            ndmGcsSetError(ndmGcsSetupHintHtml(st));
            ndmGcsSetProjectStatus("Uploads unavailable until cloud storage is connected on this server.", "error");
        } else {
            ndmGcsSetError("");
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

    function ndmGcsSetLiveStatus(text) {
        var el = document.getElementById("gcsUploadLiveStatus");
        if (el) el.textContent = text || "";
    }

    function ndmGcsSetProgress(pct, label, indeterminate, indeterminateAt) {
        var wrap = document.getElementById("gcsUploadProgress");
        var bar = document.getElementById("gcsUploadProgressBar");
        var lbl = document.getElementById("gcsUploadProgressLabel");
        if (wrap) {
            wrap.hidden = false;
            wrap.classList.toggle("ndm-gcs-progress--busy", !!indeterminate);
            wrap.classList.toggle("ndm-gcs-progress--done", !indeterminate && pct >= 100);
        }
        if (bar) {
            bar.classList.toggle("ndm-gcs-progress__bar--indeterminate", !!indeterminate);
            if (!indeterminate) {
                bar.style.marginLeft = "0";
                bar.style.width = Math.min(100, Math.max(0, pct)) + "%";
                bar.textContent = Math.round(pct) + "%";
            } else {
                var span = 12;
                var anchor = typeof indeterminateAt === "number" ? indeterminateAt : pct;
                bar.style.width = span + "%";
                bar.style.marginLeft = Math.max(0, Math.min(100 - span, anchor - span / 2)) + "%";
                bar.textContent = "···";
            }
        }
        if (lbl) lbl.textContent = label || "";
    }

    function ndmGcsFormatElapsed(seconds) {
        var s = Math.max(0, Math.floor(seconds || 0));
        var hrs = Math.floor(s / 3600);
        var mins = Math.floor((s % 3600) / 60);
        var rem = s % 60;
        if (hrs > 0) return hrs + "h " + mins + "m " + rem + "s";
        if (mins > 0) return mins + "m " + rem + "s";
        return rem + "s";
    }

    function ndmGcsGetUploadElapsed() {
        if (!ndmGcsUploadStartedAt) return "0s";
        return ndmGcsFormatElapsed((Date.now() - ndmGcsUploadStartedAt) / 1000);
    }

    function ndmGcsUpdateElapsedDisplay(finalLabel) {
        var el = document.getElementById("gcsUploadElapsed");
        if (!el) return;
        if (finalLabel) {
            el.textContent = finalLabel;
            return;
        }
        if (!ndmGcsUploadStartedAt) {
            el.textContent = "";
            return;
        }
        el.textContent = "Elapsed: " + ndmGcsGetUploadElapsed();
    }

    function ndmGcsStartUploadTimer() {
        ndmGcsStopUploadTimer();
        ndmGcsUploadStartedAt = Date.now();
        var elapsedEl = document.getElementById("gcsUploadElapsed");
        if (elapsedEl) elapsedEl.hidden = false;
        ndmGcsUpdateElapsedDisplay();
        ndmGcsUploadElapsedTimer = setInterval(ndmGcsUpdateElapsedDisplay, 1000);
    }

    function ndmGcsStopUploadTimer(finalLabel) {
        if (ndmGcsUploadElapsedTimer) {
            clearInterval(ndmGcsUploadElapsedTimer);
            ndmGcsUploadElapsedTimer = null;
        }
        if (finalLabel) {
            ndmGcsUpdateElapsedDisplay(finalLabel);
        } else if (!ndmGcsUploadStartedAt) {
            var el = document.getElementById("gcsUploadElapsed");
            if (el) {
                el.textContent = "";
                el.hidden = true;
            }
        }
        ndmGcsUploadStartedAt = 0;
    }

    function ndmGcsPollCommitProgress(uploadId, expectedTotal, sessionForComplete, isZipUpload) {
        var def = $.Deferred();
        var lastLogged = 0;
        var lastDone = 0;
        var uiFinished = false;
        var lastStatusMsg = "";
        var pollCount = 0;

        /** Step 2 spans 40–100% on the overall bar (step 1 uses 0–40%). */
        function step2OverallPct(subPhase, p, done, total) {
            if (subPhase === "preparing") return { pct: 41, indeterminate: true };
            if (subPhase === "downloading_zip") {
                var bDone = (p && p.bytesCompleted) || 0;
                var bTotal = (p && p.bytesTotal) || 0;
                if (bTotal > 0) {
                    return { pct: 40 + Math.round((bDone / bTotal) * 15), indeterminate: false };
                }
                return { pct: 42, indeterminate: true };
            }
            if (subPhase === "extracting") {
                return { pct: 58, indeterminate: true };
            }
            if (p && p.done) {
                return { pct: 100, indeterminate: false };
            }
            if (total > 0) {
                if (done >= total) return { pct: 98, indeterminate: true };
                return { pct: 62 + Math.round((done / total) * 36), indeterminate: false };
            }
            return { pct: 45, indeterminate: true };
        }

        function finishUi(commit) {
            if (uiFinished) return;
            uiFinished = true;
            var n = (commit && commit.filesUploaded) || expectedTotal || lastDone || 0;
            var projectLabel = sessionForComplete && (sessionForComplete.projectName || sessionForComplete.sanitizedName);
            var totalTime = ndmGcsGetUploadElapsed();
            ndmGcsStopUploadTimer("Total time: " + totalTime);
            ndmGcsSetProgress(100, "Done — " + n + " file(s) uploaded (" + totalTime + ")", false);
            ndmGcsSetLiveStatus("Complete — " + n + " file(s) uploaded · " + totalTime);
            ndmGcsLogLine("Upload complete.", "ok");
            ndmGcsLogLine(projectLabel
                ? "Complete: " + n + " file(s) added to project \"" + projectLabel + "\""
                : "Complete: " + n + " file(s) uploaded", "ok");
            if (sessionForComplete) {
                ndmGcsMergeProjectIntoCache(sessionForComplete.projectName, sessionForComplete.sanitizedName);
                ndmGcsSetProjectStatusFromCache(false);
            }
        }

        function finishSuccess(p) {
            finishUi(p);
            if (def.state() === "pending") {
                def.resolve(p || {
                    success: true,
                    filesUploaded: expectedTotal || lastDone
                });
            }
        }

        function finishWhenVerified(p) {
            if (uiFinished) return;
            if (!p || !p.success) return;
            if (!p.done && p.phase !== "complete") return;
            finishSuccess(p);
        }

        function poll() {
            if (uiFinished && def.state() !== "pending") return;
            var progressUrl = ndmApi("/gcs/upload/" + uploadId + "/progress") +
                ndmTokenQs() + (ndmTokenQs().indexOf("?") >= 0 ? "&" : "?") + "_=" + Date.now();
            $.ajax($.extend({
                url: progressUrl,
                type: "GET",
                dataType: "json",
                timeout: 60000
            }, ndmGcsAjaxOpts)).done(function(p) {
                    pollCount++;
                    if (!p || typeof p !== "object") {
                        ndmGcsSetLiveStatus("Waiting for server (poll #" + pollCount + ")…");
                        setTimeout(poll, 2000);
                        return;
                    }
                    if (p && p.phase === "waiting") {
                        ndmGcsSetLiveStatus((p.statusMessage || "Reconnecting to server session…") +
                            " · poll #" + pollCount);
                        setTimeout(poll, 2000);
                        return;
                    }
                    if (p && p.error && !p.done) {
                        if (p.phase === "error") {
                            def.reject(p.error);
                            return;
                        }
                        if (/not found or expired/i.test(String(p.error)) && pollCount > 45) {
                            def.reject(p.error + " — upload session was lost (server restart or deploy). Please retry.");
                            return;
                        }
                        ndmGcsSetLiveStatus("Server error: " + p.error + " · poll #" + pollCount);
                        setTimeout(poll, 2000);
                        return;
                    }
                    if (p && p.done && p.success && !p.error) {
                        finishWhenVerified(p);
                        return;
                    }
                    if (p && p.done && p.error) {
                        def.reject(p.error);
                        return;
                    }
                    var total = (p && p.filesTotal) || expectedTotal || 0;
                    var done = (p && p.filesCompleted) || 0;
                    var subPhase = (p && p.subPhase) || "";
                    var statusMsg = (p && p.statusMessage) || "";
                    if (done > lastDone) lastDone = done;

                    if (statusMsg && statusMsg !== lastStatusMsg) {
                        ndmGcsLogLine(statusMsg, "ok");
                        lastStatusMsg = statusMsg;
                    }

                    var elapsed = ndmGcsGetUploadElapsed();
                    var prog = step2OverallPct(subPhase, p, done, total);
                    var pct = prog.pct;
                    var indeterminate = prog.indeterminate;
                    var label = "Step 2/2 — Processing… (" + elapsed + ")";
                    var live = "Working · poll #" + pollCount + " · " + elapsed + " elapsed";

                    if (subPhase === "downloading_zip") {
                        var bDone = (p && p.bytesCompleted) || 0;
                        var bTotal = (p && p.bytesTotal) || 0;
                        if (bTotal > 0) {
                            var dlPct = Math.round((bDone / bTotal) * 100);
                            label = "Step 2/2 — Downloading archive: " + dlPct + "% (" + elapsed + ")";
                            live = "Downloading archive · " + ndmGcsFormatBytes(bDone) + " / " +
                                ndmGcsFormatBytes(bTotal) + " · " + elapsed;
                        } else {
                            label = "Step 2/2 — Downloading archive from cloud… (" + elapsed + ")";
                            live = "Downloading archive from cloud storage · " + elapsed;
                        }
                    } else if (subPhase === "extracting") {
                        label = "Step 2/2 — Extracting archive on server… (" + elapsed + ")";
                        live = "Extracting archive on server (this can take several minutes) · " + elapsed;
                    } else if (subPhase === "preparing") {
                        label = "Step 2/2 — Preparing archive… (" + elapsed + ")";
                        live = "Preparing archive on server · " + elapsed;
                        if (pollCount > 30) {
                            live += " · if this persists, the archive may be missing or incomplete in storage";
                        }
                    } else if (total > 0) {
                        var uploading = done < total;
                        label = uploading
                            ? "Step 2/2 — Uploading extracted files: " + done + " / " + total + " (" + elapsed + ")"
                            : "Step 2/2 — Finalizing… (" + elapsed + ")";
                        live = uploading
                            ? "Uploading extracted files · " + done + " / " + total + " · " + elapsed
                            : "Finalizing upload · " + elapsed;
                        if (isZipUpload && total === 1 && pollCount > 5) {
                            live += " · expected hundreds+ of files after extract — server may not have extracted the .zip";
                        }
                        if (p && p.currentFile && uploading) {
                            var short = p.currentFile;
                            if (short.length > 48) short = "…" + short.slice(-45);
                            label += " — " + short;
                            live += " · " + short;
                        }
                    } else if (statusMsg) {
                        label = "Step 2/2 — " + statusMsg + " (" + elapsed + ")";
                        live = statusMsg + " · " + elapsed;
                    }

                    ndmGcsSetProgress(pct, label, indeterminate, pct);
                    ndmGcsSetLiveStatus(live);

                    if (total > 0 && done > 0 && (done - lastLogged >= 10 || done === total)) {
                        if (!(isZipUpload && total <= 1 && done <= 1)) {
                            ndmGcsLogLine("Uploaded: " + done + "/" + total +
                                (p.currentFile ? " — " + p.currentFile : ""), "ok");
                            lastLogged = done;
                        }
                    }
                    setTimeout(poll, 2000);
                })
                .fail(function(xhr, status) {
                    if (xhr && xhr.status === 304) {
                        ndmGcsLogLine("Progress cache skipped (304) — retrying…", "ok");
                        setTimeout(poll, 1000);
                        return;
                    }
                    if (Date.now() - started > 30 * 60 * 1000) {
                        def.reject(ndmAjaxFailMessage(xhr, status, ndmApi("/gcs/upload/" + uploadId + "/progress")));
                        return;
                    }
                    setTimeout(poll, 3000);
                });
        }

        poll();
        return def.promise();
    }

    function ndmGcsFormatBytes(n) {
        if (!n || n < 1024) return (n || 0) + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
        return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    }

    function ndmGcsPutToGcs(uploadUrl, file, contentType, onUploadProgress) {
        var def = $.Deferred();
        var sessionUrl = uploadUrl;
        var total = file.size || 0;
        var chunkSize = 32 * 1024 * 1024;
        var ct = contentType || "application/octet-stream";

        function notifyProgress(loaded) {
            if (onUploadProgress) {
                onUploadProgress({ lengthComputable: true, loaded: loaded, total: total });
            }
        }

        function reject(msg) {
            ndmGcsLogLine(msg, "err");
            if (def.state() === "pending") def.reject(msg);
        }

        function resolveDone() {
            notifyProgress(total);
            if (def.state() === "pending") def.resolve();
        }

        function nextOffsetFrom308(xhr, endInclusive) {
            var rangeHdr = xhr.getResponseHeader("Range");
            if (rangeHdr) {
                var m = rangeHdr.match(/bytes=0-(\d+)/);
                if (m) return parseInt(m[1], 10) + 1;
            }
            return endInclusive + 1;
        }

        function putChunk(offset) {
            if (offset >= total) {
                resolveDone();
                return;
            }
            var end = Math.min(offset + chunkSize, total) - 1;
            var body = total === 0 ? new Blob([]) : file.slice(offset, end + 1);
            var xhr = new XMLHttpRequest();
            xhr.open("PUT", sessionUrl);
            xhr.setRequestHeader("Content-Type", ct);
            if (total === 0) {
                xhr.setRequestHeader("Content-Range", "bytes */0");
            } else {
                xhr.setRequestHeader("Content-Range", "bytes " + offset + "-" + end + "/" + total);
            }
            xhr.timeout = 0;
            if (xhr.upload && onUploadProgress) {
                xhr.upload.addEventListener("progress", function(e) {
                    if (e.lengthComputable) notifyProgress(offset + e.loaded);
                });
            }
            xhr.onload = function() {
                if (xhr.status === 200 || xhr.status === 201) {
                    resolveDone();
                    return;
                }
                if (xhr.status === 308) {
                    var next = nextOffsetFrom308(xhr, end);
                    if (next >= total) {
                        resolveDone();
                        return;
                    }
                    if (next <= offset) {
                        reject("GCS upload stalled (HTTP 308 at byte " + offset + " of " + total + ")");
                        return;
                    }
                    notifyProgress(next);
                    putChunk(next);
                    return;
                }
                reject("GCS upload failed (HTTP " + xhr.status + " at byte " + offset + " of " + total + ")");
            };
            xhr.onerror = function() {
                reject("GCS upload network error at byte " + offset + " of " + total);
            };
            xhr.ontimeout = function() {
                reject("GCS upload timed out at byte " + offset + " of " + total);
            };
            xhr.send(body);
        }

        putChunk(0);
        return def.promise();
    }

    function ndmGcsDirectUploadOne(uploadId, item, attempt, onUploadProgress) {
        attempt = attempt || 0;
        var def = $.Deferred();
        var rel = item.relativePath || item.file.name;
        var contentType = ndmGcsIsZipItem(item)
            ? "application/zip"
            : (item.file.type || "application/octet-stream");

        $.ajax($.extend({
            url: ndmApi("/gcs/upload/" + uploadId + "/sign") + ndmTokenQs(),
            type: "POST",
            contentType: "application/json",
            data: JSON.stringify({ relativePath: rel, contentType: contentType }),
            timeout: 120000
        }, ndmGcsAjaxOpts)).done(function(sig) {
            if (sig && sig.error) {
                def.reject(sig.error);
                return;
            }
            var putType = (sig && sig.contentType) || contentType;
            ndmGcsLogLine("Uploading to cloud: " + (rel.length > 64 ? "…" + rel.slice(-61) : rel) +
                " (" + ndmGcsFormatBytes(item.file.size) + ")", "ok");
            ndmGcsPutToGcs(sig.signedUrl, item.file, putType, onUploadProgress).done(function() {
                $.ajax($.extend({
                    url: ndmApi("/gcs/upload/" + uploadId + "/complete") + ndmTokenQs(),
                    type: "POST",
                    contentType: "application/json",
                    data: JSON.stringify({
                        relativePath: sig.relativePath || rel,
                        expectedBytes: item.file.size || 0
                    }),
                    timeout: 60000
                }, ndmGcsAjaxOpts)).done(function(doneRes) {
                    if (doneRes && doneRes.error) def.reject(doneRes.error);
                    else def.resolve(doneRes);
                }).fail(function(xhr, status) {
                    def.reject(ndmAjaxFailMessage(xhr, status, ndmApi("/gcs/upload/" + uploadId + "/complete")));
                });
            }).fail(function(err) {
                if (attempt < 2) {
                    ndmGcsDirectUploadOne(uploadId, item, attempt + 1, onUploadProgress).then(def.resolve, def.reject);
                } else {
                    def.reject(String(err) + " (" + rel + ")");
                }
            });
        }).fail(function(xhr, status) {
            if (attempt < 2 && status !== "abort") {
                ndmGcsDirectUploadOne(uploadId, item, attempt + 1, onUploadProgress).then(def.resolve, def.reject);
            } else {
                def.reject(ndmAjaxFailMessage(xhr, status, ndmApi("/gcs/upload/" + uploadId + "/sign")) +
                    " (" + rel + ")");
            }
        });
        return def.promise();
    }

    function ndmGcsShouldUploadZipViaServer(item) {
        if (!ndmGcsIsZipItem(item)) return false;
        if (ndmGcsIsRemoteHost() && item.file.size > 90 * 1024 * 1024) return false;
        return true;
    }

    function ndmGcsStageFilesDirect(uploadId, items, onProgress) {
        var def = $.Deferred();
        var totalFiles = items.length;
        var uploaded = 0;
        var failed = null;
        var queue = items.slice();
        var inFlight = {};
        var concurrency = ndmGcsIsRemoteHost() ? 8 : 12;
        var lastProgressAt = Date.now();

        function notifyProgress(res) {
            if (onProgress) {
                var keys = Object.keys(inFlight);
                var flights = keys.map(function(k) { return inFlight[k]; });
                onProgress(uploaded, totalFiles, null, res, flights);
            }
        }

        function failOne(err) {
            failed = err;
            clearInterval(stallTimer);
            if (def.state() === "pending") def.reject(failed);
        }

        function startOne(item) {
            var key = item.relativePath || item.file.name;
            inFlight[key] = {
                item: item,
                startedAt: Date.now(),
                lastByteAt: Date.now(),
                bytesLoaded: 0,
                bytesTotal: item.file.size || 0
            };
            notifyProgress(null);

            var uploadFn = ndmGcsShouldUploadZipViaServer(item) ? ndmGcsUploadOneFile : ndmGcsDirectUploadOne;
            uploadFn(uploadId, item, 0, function(e) {
                if (inFlight[key]) {
                    inFlight[key].lastByteAt = Date.now();
                    if (e && e.lengthComputable) inFlight[key].bytesLoaded = e.loaded;
                }
                lastProgressAt = Date.now();
                notifyProgress(null);
            }).done(function(res) {
                delete inFlight[key];
                uploaded++;
                lastProgressAt = Date.now();
                notifyProgress(res);
                pump();
            }).fail(function(err) {
                delete inFlight[key];
                if (!failed) failOne(err);
            });
        }

        function pump() {
            if (failed || def.state() !== "pending") return;
            while (queue.length && Object.keys(inFlight).length < concurrency) {
                startOne(queue.shift());
            }
            if (!queue.length && !Object.keys(inFlight).length) {
                clearInterval(stallTimer);
                def.resolve();
            }
        }

        var stallTimer = setInterval(function() {
            if (def.state() !== "pending") return;
            var now = Date.now();
            var keys = Object.keys(inFlight);
            if (keys.length) {
                var flight = inFlight[keys[0]];
                var lastActivity = flight.lastByteAt || flight.startedAt;
                if (now - lastActivity < 120000) return;
                if (now - flight.startedAt < ndmGcsFileStallBudgetMs(flight.item)) return;
            }
            if (now - lastProgressAt > 20 * 60 * 1000) {
                var hint = keys.length ? " Still waiting on: " + keys[0] + "." : "";
                failOne("Upload stalled (" + uploaded + " / " + totalFiles + " to GCS)." + hint);
            }
        }, 15000);

        if (!totalFiles) {
            def.resolve();
        } else {
            pump();
        }
        return def.promise();
    }

    function ndmGcsStageFiles(uploadId, items, onProgress, useDirect) {
        if (useDirect) return ndmGcsStageFilesDirect(uploadId, items, onProgress);
        return ndmGcsStageFilesParallel(uploadId, items, onProgress);
    }

    function ndmGcsUploadOneFile(uploadId, item, attempt, onUploadProgress) {
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
            timeout: timeoutMs,
            xhr: function() {
                var xhr = $.ajaxSettings.xhr();
                if (xhr.upload && onUploadProgress) {
                    xhr.upload.addEventListener("progress", function(e) {
                        if (e.lengthComputable && e.loaded > 0) onUploadProgress(e);
                    });
                }
                return xhr;
            }
        }, ndmGcsAjaxOpts));
        jqXhr.done(function(res) {
            if (res && res.error) def.reject(res.error);
            else def.resolve(res, jqXhr);
        }).fail(function(xhr, status) {
            if (attempt < 2 && status !== "abort") {
                ndmGcsUploadOneFile(uploadId, item, attempt + 1, onUploadProgress).then(def.resolve, def.reject);
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
            dataType: "json",
            timeout: 120000
        }, ndmGcsAjaxOpts));
    }

    function ndmGcsIsZipItem(item) {
        var name = (item && (item.relativePath || item.file.name)) || "";
        return /\.zip$/i.test(name);
    }

    function ndmGcsBuildUploadBatches(items) {
        var remote = ndmGcsIsRemoteHost();
        var maxFiles = remote ? 20 : 40;
        var maxBytes = remote ? 64 * 1024 * 1024 : 160 * 1024 * 1024;
        var largeThreshold = 25 * 1024 * 1024;
        var sorted = items.slice().sort(function(a, b) { return a.file.size - b.file.size; });
        var batches = [];
        var current = [];
        var currentBytes = 0;

        function flush() {
            if (current.length) {
                batches.push(current);
                current = [];
                currentBytes = 0;
            }
        }

        sorted.forEach(function(item) {
            if (ndmGcsIsZipItem(item)) {
                flush();
                batches.push([item]);
                return;
            }
            if (item.file.size > largeThreshold) {
                flush();
                batches.push([item]);
                return;
            }
            if (current.length >= maxFiles || (currentBytes + item.file.size > maxBytes && current.length)) {
                flush();
            }
            current.push(item);
            currentBytes += item.file.size;
        });
        flush();
        return batches;
    }

    function ndmGcsUploadBatch(uploadId, batchItems, attempt, onUploadProgress) {
        attempt = attempt || 0;
        if (batchItems.length === 1) {
            return ndmGcsUploadOneFile(uploadId, batchItems[0], attempt, onUploadProgress);
        }
        var def = $.Deferred();
        var fd = new FormData();
        var paths = [];
        var totalBytes = 0;
        batchItems.forEach(function(item) {
            fd.append("files", item.file, item.file.name);
            paths.push(item.relativePath || item.file.name);
            totalBytes += item.file.size;
        });
        fd.append("relativePaths", JSON.stringify(paths));
        var totalMb = totalBytes / (1024 * 1024);
        var timeoutMs = totalMb > 200 ? 3600000 : totalMb > 50 ? 1800000 : 900000;
        var jqXhr = $.ajax($.extend({
            url: ndmApi("/gcs/upload/" + uploadId + "/batch") + ndmTokenQs(),
            type: "POST",
            data: fd,
            processData: false,
            contentType: false,
            timeout: timeoutMs,
            xhr: function() {
                var xhr = $.ajaxSettings.xhr();
                if (xhr.upload && onUploadProgress) {
                    xhr.upload.addEventListener("progress", function(e) {
                        if (e.lengthComputable && e.loaded > 0) onUploadProgress(e);
                    });
                }
                return xhr;
            }
        }, ndmGcsAjaxOpts));
        jqXhr.done(function(res) {
            if (res && res.error) def.reject(res.error);
            else def.resolve(res);
        }).fail(function(xhr, status) {
            if (attempt < 2 && status !== "abort") {
                ndmGcsUploadBatch(uploadId, batchItems, attempt + 1, onUploadProgress).then(def.resolve, def.reject);
            } else {
                def.reject(ndmAjaxFailMessage(xhr, status, ndmApi("/gcs/upload/" + uploadId + "/batch")) +
                    " (batch of " + batchItems.length + " files)");
            }
        });
        return def.promise();
    }

    function ndmGcsStageFilesParallel(uploadId, items, onProgress) {
        var def = $.Deferred();
        var batches = ndmGcsBuildUploadBatches(items);
        var totalFiles = items.length;
        var uploaded = 0;
        var batchIdx = 0;
        var failed = null;
        var inFlight = null;
        var lastProgressAt = Date.now();
        var remote = ndmGcsIsRemoteHost();

        function notifyProgress(res) {
            if (onProgress) {
                onProgress(uploaded, totalFiles, null, res, inFlight ? [inFlight] : []);
            }
        }

        function failOne(err) {
            failed = err;
            clearInterval(stallTimer);
            clearInterval(heartbeatTimer);
            if (def.state() === "pending") def.reject(failed);
        }

        function uploadNextBatch() {
            if (failed || def.state() !== "pending") return;
            if (batchIdx >= batches.length) {
                clearInterval(stallTimer);
                clearInterval(heartbeatTimer);
                def.resolve();
                return;
            }
            var batch = batches[batchIdx++];
            var batchNum = batchIdx;
            var batchBytes = 0;
            batch.forEach(function(it) { batchBytes += it.file.size; });
            inFlight = {
                item: { relativePath: "batch " + batchNum + "/" + batches.length + " (" + batch.length + " files)", file: { size: batchBytes } },
                startedAt: Date.now(),
                lastByteAt: Date.now()
            };
            notifyProgress(null);

            ndmGcsUploadBatch(uploadId, batch, 0, function() {
                if (inFlight) inFlight.lastByteAt = Date.now();
                lastProgressAt = Date.now();
            }).done(function(res) {
                uploaded += batch.length;
                lastProgressAt = Date.now();
                inFlight = null;
                notifyProgress(res);
                uploadNextBatch();
            }).fail(function(err) {
                inFlight = null;
                if (!failed) failOne(err);
            });
        }

        var stallTimer = setInterval(function() {
            if (def.state() !== "pending") return;
            var now = Date.now();
            if (inFlight) {
                var lastActivity = inFlight.lastByteAt || inFlight.startedAt;
                if (now - lastActivity < 120000) return;
                if (now - inFlight.startedAt < ndmGcsFileStallBudgetMs(inFlight.item)) return;
            }
            var stalledMs = now - lastProgressAt;
            if (stalledMs > (inFlight ? 20 * 60 * 1000 : NDM_GCS_STALL_MS)) {
                var hint = inFlight ? " Still waiting on: " + (inFlight.item.relativePath || "current batch") + "." : "";
                var remoteHint = remote
                    ? " Try uploading one .zip instead of many files over HTTPS."
                    : " Large folders upload faster as one .zip.";
                failOne("Upload stalled (" + uploaded + " / " + totalFiles + " sent)." + hint + remoteHint);
            }
        }, 15000);

        var heartbeatTimer = setInterval(function() {
            if (def.state() !== "pending" || !inFlight) return;
            notifyProgress(null);
        }, 3000);

        if (!totalFiles) {
            def.resolve();
        } else {
            uploadNextBatch();
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
        var zipItems = ndmGcsFiles.filter(ndmGcsIsZipItem);
        if (zipItems.length > 1) {
            ndmGcsSetError("Upload one .zip file at a time.");
            return;
        }
        if (zipItems.length === 1 && fileCount > 1) {
            ndmGcsSetError("When uploading a .zip, add only that archive — not other files at the same time.");
            return;
        }
        if (fileCount > NDM_GCS_MAX_INDIVIDUAL_FILES) {
            ndmGcsSetError(
                "This selection has " + fileCount + " files. Uploading each file separately is not reliable at this scale " +
                "(folders like entwine/ept-data contain thousands of tiny tiles). " +
                "Zip the project folder on your computer, then upload that single .zip file here."
            );
            return;
        }
        ndmGcsSetError("");
        var startBtn = document.getElementById("gcsUploadStart");
        var clearBtn = document.getElementById("gcsUploadClear");
        if (startBtn) startBtn.disabled = true;
        if (clearBtn) clearBtn.disabled = true;

        var log = document.getElementById("gcsUploadLog");
        if (log) log.innerHTML = "";
        ndmGcsStartUploadTimer();
        ndmGcsSetProgress(0, "Starting upload session…");
        ndmGcsSetLiveStatus("Starting upload session…");

        $.ajax($.extend({
            url: ndmApi("/gcs/upload/init") + ndmTokenQs(),
            type: "POST",
            contentType: "application/json",
            data: JSON.stringify({ projectName: projectName })
        }, ndmGcsAjaxOpts)).done(function(session) {
            if (session.error) {
                ndmGcsStopUploadTimer();
                ndmGcsSetError(session.error);
                if (startBtn) startBtn.disabled = false;
                if (clearBtn) clearBtn.disabled = false;
                return;
            }

            ndmGcsUpdateProjectUriPreview();

            var uploadId = session.uploadId;
            var total = ndmGcsFiles.length;
            var useDirect = !!(session.directUpload || ndmGcsDirectUpload);
            var gcsUploadOk = false;

            ndmGcsStageFiles(uploadId, ndmGcsFiles, function(done, tot, item, res, inFlight) {
                var phasePct = 0;
                if (tot > 0) {
                    var completedShare = (done / tot) * 40;
                    var inFlightShare = 0;
                    if (useDirect && inFlight && inFlight.length) {
                        var sumLoaded = 0;
                        var sumTotal = 0;
                        inFlight.forEach(function(flight) {
                            sumLoaded += flight.bytesLoaded || 0;
                            sumTotal += (flight.bytesTotal || (flight.item && flight.item.file && flight.item.file.size) || 0);
                        });
                        if (sumTotal > 0) {
                            inFlightShare = (sumLoaded / sumTotal) * (40 / tot);
                        }
                    }
                    phasePct = Math.min(40, Math.round(completedShare + inFlightShare));
                }
                var label = useDirect
                    ? (zipItems.length === 1 && tot === 1
                        ? "Step 1/2 — Uploading archive"
                        : "Step 1/2 — Uploading: " + done + " / " + tot)
                    : "Step 1/2 — Sending to server: " + done + " / " + tot;
                var elapsed = ndmGcsGetUploadElapsed();
                label += " (" + elapsed + ")";
                if (inFlight && inFlight.length) {
                    var flight = inFlight[0];
                    var name = flight.item.relativePath || flight.item.file.name || "";
                    if (name.length > 48) name = "…" + name.slice(-45);
                    label += " — " + name;
                    if (flight.bytesTotal > 0 && flight.bytesLoaded >= 0) {
                        label += " (" + ndmGcsFormatBytes(flight.bytesLoaded) + " / " + ndmGcsFormatBytes(flight.bytesTotal) + ")";
                    }
                }
                ndmGcsSetProgress(phasePct, label);
                if (inFlight && inFlight.length) {
                    var liveFlight = inFlight[0];
                    if (liveFlight.bytesTotal > 0) {
                        ndmGcsSetLiveStatus("Step 1 · uploading · " + ndmGcsFormatBytes(liveFlight.bytesLoaded) +
                            " / " + ndmGcsFormatBytes(liveFlight.bytesTotal) + " · " + elapsed);
                    } else {
                        ndmGcsSetLiveStatus("Step 1 · " + done + " / " + tot + " file(s) · " + elapsed);
                    }
                } else {
                    ndmGcsSetLiveStatus("Step 1 · " + done + " / " + tot + " file(s) · " + elapsed);
                }
                if (useDirect) {
                    if (zipItems.length === 1 && done === tot && tot > 0) {
                        ndmGcsLogLine("Archive uploaded — step 2 will extract and upload folder contents", "ok");
                    } else if (tot > 1 && done > 0 && (done === tot || done % 50 === 0)) {
                        ndmGcsLogLine("Uploaded: " + done + " / " + tot + " file(s)", "ok");
                    }
                } else if (res && res.extracted) {
                    ndmGcsLogLine("ZIP extracted on server (" + (res.stagedFiles || 0) + " files) — uploading contents in step 2…", "ok");
                } else if (res && res.batchSize) {
                    if (done > 0 && (done === tot || done % 50 === 0)) {
                        ndmGcsLogLine("Server received " + done + " / " + tot + " files (batch upload)", "ok");
                    }
                } else if (done > 0 && (done === tot || done % 50 === 0)) {
                    ndmGcsLogLine("Server received " + done + " / " + tot + " files", "ok");
                }
            }, useDirect).done(function() {
                var elapsed = ndmGcsGetUploadElapsed();
                ndmGcsSetProgress(40, useDirect
                    ? (zipItems.length === 1
                        ? "Step 1/2 complete — archive received (" + elapsed + ")"
                        : "Step 1/2 complete — starting step 2… (" + elapsed + ")")
                    : "Step 1/2 complete — starting upload to Google Cloud… (" + elapsed + ")");
                ndmGcsSetLiveStatus("Step 1 complete — starting step 2 on server… · " + elapsed);
                ndmGcsLogLine(useDirect
                    ? (zipItems.length === 1
                        ? "Step 1/2 complete — archive in cloud, starting extraction…"
                        : "Step 1/2 complete — verifying upload…")
                    : "All files on server. Uploading folder structure to GCS…", "ok");
                return ndmGcsCommitUpload(uploadId);
            }).done(function(start) {
                if (start && start.error) {
                    return $.Deferred().reject(start.error).promise();
                }
                var n = (start && start.filesTotal != null) ? start.filesTotal : total;
                var isZip = zipItems.length === 1;
                var elapsed = ndmGcsGetUploadElapsed();
                ndmGcsSetProgress(41, isZip
                    ? "Step 2/2 — Preparing archive… (" + elapsed + ")"
                    : "Step 2/2 — Processing… (" + elapsed + ")", true, 41);
                ndmGcsSetLiveStatus(isZip
                    ? "Step 2 started — server will download, extract, and upload contents… · " + elapsed
                    : "Step 2 started — processing on server… · " + elapsed);
                ndmGcsLogLine(isZip
                    ? "Step 2/2 — archive received; download, extract, and upload will run on the server…"
                    : "Step 2/2 — processing " + n + " file(s)…", "ok");
                return ndmGcsPollCommitProgress(uploadId, isZip ? null : n, session, isZip);
            }).done(function() {
                gcsUploadOk = true;
            }).fail(function(err) {
                if (err) ndmGcsSetError(String(err));
            }).always(function() {
                if (!gcsUploadOk) {
                    ndmGcsStopUploadTimer();
                }
                var wrap = document.getElementById("gcsUploadProgress");
                if (wrap) wrap.classList.remove("ndm-gcs-progress--busy");
                var bar = document.getElementById("gcsUploadProgressBar");
                if (bar) bar.classList.remove("ndm-gcs-progress__bar--indeterminate");
                if (uploadId) {
                    var delQs = ndmTokenQs();
                    if (!gcsUploadOk) {
                        delQs += (delQs.indexOf("?") >= 0 ? "&" : "?") + "abandon=1";
                    }
                    $.ajax($.extend({
                        url: ndmApi("/gcs/upload/" + uploadId) + delQs,
                        type: "DELETE"
                    }, ndmGcsAjaxOpts));
                }
                if (startBtn) startBtn.disabled = !ndmGcsEnabled || !ndmGcsFiles.length;
                if (clearBtn) clearBtn.disabled = false;
            });
        }).fail(function(xhr, status) {
            ndmGcsStopUploadTimer();
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