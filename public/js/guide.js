(function() {
    "use strict";

    var input = document.getElementById("guideSearch");
    var clearBtn = document.getElementById("guideSearchClear");
    var statusEl = document.getElementById("guideSearchStatus");
    var emptyEl = document.getElementById("guideEmpty");
    var emptyClearBtn = document.getElementById("guideEmptyClear");
    var tocList = document.getElementById("guideTocList");
    var header = document.querySelector(".guide-header");
    var toTopBtn = document.getElementById("guideToTop");
    var TO_TOP_THRESHOLD_PX = 400;

    function normalize(text) {
        return String(text || "").replace(/\s+/g, " ").toLowerCase();
    }

    function headingText(el, selector) {
        var heading = el.querySelector(selector);
        return heading ? heading.textContent.trim() : "";
    }

    var allTopics = [];
    var chapters = Array.prototype.map.call(document.querySelectorAll(".guide-chapter"), function(el) {
        var chapter = { el: el, title: headingText(el, "h2"), tocItem: null, tocLink: null, topics: [] };
        Array.prototype.forEach.call(el.querySelectorAll(".guide-topic"), function(topicEl) {
            var topic = {
                el: topicEl,
                title: headingText(topicEl, "h3"),
                // Highlighting only wraps text in <mark>, so textContent never changes.
                searchText: normalize(chapter.title + " " + topicEl.textContent),
                tocItem: null,
                tocLink: null
            };
            chapter.topics.push(topic);
            allTopics.push(topic);
        });
        return chapter;
    });

    var hits = [];
    var currentHit = -1;
    var debounceTimer = null;
    var lastQuery = null;
    var activeTopic = null;

    function escapeRegExp(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function termsFrom(query) {
        var seen = Object.create(null);
        return normalize(query).split(" ").filter(function(t) {
            if (!t || seen[t]) return false;
            seen[t] = true;
            return true;
        });
    }

    function makeTocLink(className, target, text) {
        var link = document.createElement("a");
        link.className = className;
        link.href = "#" + target.id;
        link.textContent = text;
        return link;
    }

    function buildToc() {
        chapters.forEach(function(chapter) {
            chapter.tocItem = document.createElement("li");
            chapter.tocItem.className = "guide-toc__chapter";
            chapter.tocLink = makeTocLink("guide-toc__chapter-link", chapter.el, chapter.title);
            chapter.tocItem.appendChild(chapter.tocLink);

            var sub = document.createElement("ol");
            sub.className = "guide-toc__sublist";
            chapter.topics.forEach(function(topic) {
                topic.tocItem = document.createElement("li");
                topic.tocLink = makeTocLink("guide-toc__topic-link", topic.el, topic.title);
                topic.tocItem.appendChild(topic.tocLink);
                sub.appendChild(topic.tocItem);
            });
            chapter.tocItem.appendChild(sub);
            tocList.appendChild(chapter.tocItem);
        });
    }

    function clearHighlights(root) {
        var marks = root.querySelectorAll("mark.guide-hit");
        Array.prototype.forEach.call(marks, function(mark) {
            var parent = mark.parentNode;
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
            parent.normalize();
        });
    }

    function highlight(root, regex) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function(node) {
                if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                var tag = node.parentNode && node.parentNode.nodeName;
                if (tag === "SCRIPT" || tag === "STYLE" || tag === "MARK") return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        var nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);

        var marks = [];
        nodes.forEach(function(node) {
            var text = node.nodeValue;
            regex.lastIndex = 0;
            var match = regex.exec(text);
            if (!match) return;

            var frag = document.createDocumentFragment();
            var last = 0;
            while (match) {
                if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
                var mark = document.createElement("mark");
                mark.className = "guide-hit";
                mark.textContent = match[0];
                frag.appendChild(mark);
                marks.push(mark);
                last = match.index + match[0].length;
                if (match[0].length === 0) regex.lastIndex++;
                match = regex.exec(text);
            }
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
            node.parentNode.replaceChild(frag, node);
        });
        return marks;
    }

    function setCurrentHit(index) {
        if (currentHit >= 0 && hits[currentHit]) hits[currentHit].classList.remove("guide-hit--current");
        currentHit = index;
        var mark = hits[currentHit];
        if (!mark) return;
        mark.classList.add("guide-hit--current");
        mark.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    function updateUrl(query) {
        if (!window.history || !window.history.replaceState) return;
        var url = new URL(window.location.href);
        if (query) url.searchParams.set("q", query);
        else url.searchParams.delete("q");
        window.history.replaceState(null, "", url.toString());
    }

    function runSearch() {
        clearTimeout(debounceTimer);
        var query = input.value.trim();
        var terms = termsFrom(query);
        lastQuery = query;

        clearHighlights(document.getElementById("guideContent"));
        clearHighlights(tocList);
        hits = [];
        currentHit = -1;
        clearBtn.hidden = !input.value;
        updateUrl(query);

        var regex = terms.length
            ? new RegExp(terms.slice().sort(function(a, b) { return b.length - a.length; }).map(escapeRegExp).join("|"), "gi")
            : null;

        var matchedTopics = 0;
        chapters.forEach(function(chapter) {
            var visibleInChapter = 0;
            chapter.topics.forEach(function(topic) {
                var match = terms.every(function(t) { return topic.searchText.indexOf(t) !== -1; });
                topic.el.hidden = !match;
                topic.tocItem.hidden = !match;
                if (!match) return;
                visibleInChapter++;
                if (regex) {
                    Array.prototype.push.apply(hits, highlight(topic.el, regex));
                    highlight(topic.tocLink, regex);
                }
            });
            chapter.el.hidden = visibleInChapter === 0;
            chapter.tocItem.hidden = visibleInChapter === 0;
            if (regex && visibleInChapter) highlight(chapter.tocLink, regex);
            matchedTopics += visibleInChapter;
        });

        emptyEl.hidden = matchedTopics > 0;

        if (!terms.length) {
            statusEl.textContent = "";
        } else if (!matchedTopics) {
            statusEl.textContent = "No topics match “" + query + "”.";
        } else {
            statusEl.textContent = matchedTopics + (matchedTopics === 1 ? " topic matches" : " topics match") +
                " “" + query + "” · " + hits.length + (hits.length === 1 ? " highlight" : " highlights") +
                " · press Enter to jump between them";
        }

        updateActiveTocLink();
    }

    function scheduleSearch() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(runSearch, 120);
    }

    function clearSearch() {
        input.value = "";
        runSearch();
        input.focus();
    }

    var scrollTicking = false;
    function updateActiveTocLink() {
        var offset = (header ? header.offsetHeight : 0) + 40;
        var active = null;
        for (var i = 0; i < allTopics.length; i++) {
            var topic = allTopics[i];
            if (topic.el.hidden) continue;
            // Topics are in page order, so stop at the first one below the header.
            if (topic.el.getBoundingClientRect().top > offset) {
                if (!active) active = topic;
                break;
            }
            active = topic;
        }
        if (active === activeTopic) return;
        if (activeTopic) activeTopic.tocLink.classList.remove("guide-toc__topic-link--active");
        if (active) active.tocLink.classList.add("guide-toc__topic-link--active");
        activeTopic = active;
    }

    function onScroll() {
        if (scrollTicking) return;
        scrollTicking = true;
        window.requestAnimationFrame(function() {
            scrollTicking = false;
            updateActiveTocLink();
            updateToTopButton();
        });
    }

    function updateToTopButton() {
        var show = window.scrollY > TO_TOP_THRESHOLD_PX;
        toTopBtn.classList.toggle("guide-to-top--visible", show);
        toTopBtn.tabIndex = show ? 0 : -1;
    }

    function scrollToTop() {
        var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
        input.focus({ preventScroll: true });
    }

    buildToc();

    input.addEventListener("input", scheduleSearch);
    input.addEventListener("keydown", function(ev) {
        if (ev.key === "Escape") {
            if (input.value) {
                ev.preventDefault();
                clearSearch();
            } else {
                input.blur();
            }
        } else if (ev.key === "Enter") {
            ev.preventDefault();
            if (input.value.trim() !== lastQuery) runSearch();
            if (!hits.length) return;
            var next = ev.shiftKey
                ? (currentHit <= 0 ? hits.length - 1 : currentHit - 1)
                : (currentHit + 1) % hits.length;
            setCurrentHit(next);
        }
    });
    clearBtn.addEventListener("click", clearSearch);
    emptyClearBtn.addEventListener("click", clearSearch);
    toTopBtn.addEventListener("click", scrollToTop);

    document.addEventListener("keydown", function(ev) {
        if (ev.key !== "/" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        var tag = document.activeElement && document.activeElement.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        ev.preventDefault();
        input.focus();
        input.select();
    });

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    var initialQuery = new URLSearchParams(window.location.search).get("q");
    if (initialQuery) input.value = initialQuery;
    runSearch();
    updateToTopButton();
})();
