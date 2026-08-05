/*
 * Structure View -- an additive, teaching-style visualization layered on
 * top of the classic Python Tutor renderer. Renders linked lists, binary
 * trees, graphs, arrays, and hashmaps as SVG diagrams in the style of
 * classic algorithm-tutorial videos, plus a call-stack table and a
 * running output line.
 *
 * This file is entirely self-contained and self-injecting: it does not
 * require any HTML markup to be added to visualize.html beyond a single
 * <script> include. It attaches itself as window.StructureView and is
 * driven by ONE call per step from the classic renderer:
 *
 *   window.StructureView.update(curEntry, curInstr, curTrace)
 *
 * curEntry is the current trace entry (same shape the classic renderer
 * uses). curInstr/curTrace are optional extra context (current index and
 * the full trace array) used only to diff against the previous step for
 * the "just changed" amber highlight; if omitted, that highlight is
 * simply skipped.
 *
 * update() NEVER throws: every code path that touches trace data is
 * wrapped in try/catch, so a bug here can't break stepping in the
 * classic view.
 */

(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';

  // ==========================================================================
  // State (persists across steps and re-runs; in-memory only, no storage)
  // ==========================================================================

  var state = {
    darkMode: false,
    viewMode: 'both', // 'classic' | 'structure' | 'both'
    showNulls: true,
  };

  // ==========================================================================
  // Small helpers for reading the trace's value encoding
  //   primitives: numbers/strings/booleans/null pass through as-is
  //   heap refs:  ["REF", id]
  //   C pointers: ["C_DATA", addr, "pointer", targetAddrOrSentinel]
  // ==========================================================================

  function isRef(v) {
    return Array.isArray(v) && v[0] === 'REF';
  }

  function isCPointer(v) {
    return Array.isArray(v) && v[0] === 'C_DATA' && v[2] === 'pointer';
  }

  function isNullRef(v) {
    if (v === null) return true;
    if (isCPointer(v)) {
      return v[3] === '<UNINITIALIZED>' || v[3] === '<UNALLOCATED>' || v[3] === '0x0';
    }
    return false;
  }

  function refId(v) {
    if (isRef(v)) return v[1];
    if (isCPointer(v)) return v[3];
    return null;
  }

  function isPrimitive(v) {
    if (v === null) return true;
    if (typeof v !== 'object') return true; // number, string, boolean
    if (!Array.isArray(v)) return true;
    var tag = v[0];
    if (tag === 'REF') return false;
    if (tag === 'LIST' || tag === 'TUPLE' || tag === 'SET' || tag === 'DICT' ||
        tag === 'INSTANCE' || tag === 'INSTANCE_PPRINT' || tag === 'CLASS') return false;
    if (isCPointer(v)) return false;
    return true; // C_DATA (non-pointer), SPECIAL_FLOAT, JS_SPECIAL_VAL, IMPORTED_FAUX_PRIMITIVE
  }

  function primitiveDisplay(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) {
      if (v[0] === 'SPECIAL_FLOAT' || v[0] === 'JS_SPECIAL_VAL' || v[0] === 'IMPORTED_FAUX_PRIMITIVE') return String(v[1]);
      if (v[0] === 'C_DATA') return String(v[3]);
      return JSON.stringify(v);
    }
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return '"' + v + '"';
    return String(v);
  }

  function heapGet(heap, id) {
    if (!heap) return undefined;
    return heap[id] !== undefined ? heap[id] : heap[String(id)];
  }

  // ==========================================================================
  // Frame helpers: unify "inside a function call" and "top-level/global
  // scope" into one shape, since module-level Python code has an empty
  // stack_to_render and its variables live in curEntry.globals.
  // ==========================================================================

  function getCurrentFrame(curEntry) {
    var stack = curEntry.stack_to_render || [];
    // prefer the deepest non-zombie frame; fall back to the last frame; fall
    // back to a synthetic "globals" frame for top-level/module code
    for (var i = stack.length - 1; i >= 0; i--) {
      if (!stack[i].is_zombie) return stack[i];
    }
    if (stack.length > 0) return stack[stack.length - 1];
    return {
      func_name: '<module>',
      frame_id: 'globals',
      encoded_locals: curEntry.globals || {},
      ordered_varnames: curEntry.ordered_globals || [],
      is_zombie: false,
    };
  }

  function frameVars(frame) {
    var out = [];
    var names = frame.ordered_varnames || [];
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      var v = frame.encoded_locals[n];
      if (v !== undefined) out.push({ name: n, val: v });
    }
    return out;
  }

  // All variables from every live frame plus globals, deepest frame first.
  // Used to SEED shape detection/reachability so a tree or list whose true
  // root only remains referenced in an OUTER frame (common during a
  // recursive traversal, where the innermost frame's parameter only points
  // at a subtree) still gets discovered in full. Visual pointer labels
  // stay scoped to just the current frame (see frameVars(getCurrentFrame)).
  function allPointerCandidates(curEntry) {
    var out = [];
    var stack = curEntry.stack_to_render || [];
    for (var i = stack.length - 1; i >= 0; i--) {
      if (stack[i].is_zombie) continue;
      frameVars(stack[i]).forEach(function (v) { out.push(v); });
    }
    var globalsFrame = { encoded_locals: curEntry.globals || {}, ordered_varnames: curEntry.ordered_globals || [] };
    frameVars(globalsFrame).forEach(function (v) { out.push(v); });
    return out;
  }

  // ==========================================================================
  // DOM injection (idempotent -- safe to call every step)
  // ==========================================================================

  var dom = null; // cached refs, rebuilt if the visualizer's DOM was recreated

  function domIsAttached() {
    return dom && document.body.contains(dom.root);
  }

  function buildDOM() {
    var dataViz = document.getElementById('dataViz');
    if (!dataViz || !dataViz.parentNode) return null;

    var root = document.createElement('div');
    root.id = 'structureViewRoot';
    root.className = 'sv-root';
    root.innerHTML =
      '<div class="sv-controls">' +
        '<div class="sv-toggle-group" id="svViewToggle">' +
          '<button type="button" data-mode="classic">Classic</button>' +
          '<button type="button" data-mode="structure">Structure</button>' +
          '<button type="button" data-mode="both">Both</button>' +
        '</div>' +
        '<label class="sv-checkbox"><input type="checkbox" id="svShowNulls"> Show nulls</label>' +
        '<button type="button" class="sv-dark-btn" id="svDarkToggle">Dark mode</button>' +
      '</div>' +
      '<div class="sv-structure-pane" id="svStructurePane">' +
        '<div class="sv-message" id="svMessage"></div>' +
        '<div class="sv-canvas-wrap"><svg id="svCanvas" class="sv-canvas" xmlns="' + SVGNS + '"></svg></div>' +
        '<div class="sv-callstack-wrap">' +
          '<div class="sv-section-label">Call Stack</div>' +
          '<table class="sv-callstack-table" id="svCallStackTable"></table>' +
        '</div>' +
        '<div class="sv-output-line" id="svOutputLine"></div>' +
      '</div>';

    dataViz.parentNode.insertBefore(root, dataViz);

    var d = {
      root: root,
      structurePane: root.querySelector('#svStructurePane'),
      message: root.querySelector('#svMessage'),
      svg: root.querySelector('#svCanvas'),
      callStackTable: root.querySelector('#svCallStackTable'),
      outputLine: root.querySelector('#svOutputLine'),
      viewToggle: root.querySelector('#svViewToggle'),
      showNullsCheckbox: root.querySelector('#svShowNulls'),
      darkToggle: root.querySelector('#svDarkToggle'),
      dataViz: dataViz,
    };

    d.showNullsCheckbox.checked = state.showNulls;
    d.showNullsCheckbox.addEventListener('change', function () {
      state.showNulls = d.showNullsCheckbox.checked;
      rerenderLast();
    });

    d.darkToggle.addEventListener('click', function () {
      state.darkMode = !state.darkMode;
      applyDarkMode();
    });

    var modeButtons = d.viewToggle.querySelectorAll('button');
    for (var i = 0; i < modeButtons.length; i++) {
      modeButtons[i].addEventListener('click', function (evt) {
        state.viewMode = evt.currentTarget.getAttribute('data-mode');
        applyViewMode();
      });
    }

    return d;
  }

  function ensureDOM() {
    if (!domIsAttached()) {
      dom = buildDOM();
    }
    if (dom) {
      applyViewMode();
      applyDarkMode();
    }
    return dom;
  }

  function applyViewMode() {
    if (!dom) return;
    var buttons = dom.viewToggle.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var isActive = buttons[i].getAttribute('data-mode') === state.viewMode;
      buttons[i].classList.toggle('sv-active', isActive);
    }
    dom.structurePane.style.display = (state.viewMode === 'classic') ? 'none' : '';
    dom.dataViz.style.display = (state.viewMode === 'structure') ? 'none' : '';
  }

  function applyDarkMode() {
    document.body.classList.toggle('pt-dark', state.darkMode);
    if (dom) {
      dom.darkToggle.textContent = state.darkMode ? 'Light mode' : 'Dark mode';
      dom.darkToggle.classList.toggle('sv-active', state.darkMode);
    }
  }

  // ==========================================================================
  // SVG drawing helpers
  // ==========================================================================

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]);
      }
    }
    return el;
  }

  function ensureArrowMarker(svg, id, cls) {
    var defs = svg.querySelector('defs');
    if (!defs) {
      defs = svgEl('defs', {});
      svg.appendChild(defs);
    }
    if (svg.querySelector('#' + id)) return;
    var marker = svgEl('marker', {
      id: id, viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
    });
    marker.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: cls }));
    defs.appendChild(marker);
  }

  function textNode(x, y, str, cls, anchor) {
    var t = svgEl('text', { x: x, y: y, class: cls || 'sv-label', 'text-anchor': anchor || 'middle' });
    t.textContent = str;
    return t;
  }

  function line(x1, y1, x2, y2, cls, markerEnd) {
    var attrs = { x1: x1, y1: y1, x2: x2, y2: y2, class: cls };
    if (markerEnd) attrs['marker-end'] = 'url(#' + markerEnd + ')';
    return svgEl('line', attrs);
  }

  function rect(x, y, w, h, cls, rx) {
    return svgEl('rect', { x: x, y: y, width: w, height: h, class: cls, rx: rx || 4 });
  }

  function circle(cx, cy, r, cls) {
    return svgEl('circle', { cx: cx, cy: cy, r: r, class: cls });
  }

  // ==========================================================================
  // Shape detection
  //
  // Every detector receives (heap, frame, allFrameVars) and returns either
  // null (no match) or a small descriptor object. Multiple shapes may be
  // detected simultaneously (e.g. a graph plus its visited array) and are
  // all rendered as separate panels.
  // ==========================================================================

  // Classify every INSTANCE class reachable from the given roots by its
  // "link field" pattern: exactly one self-referencing field => list node,
  // exactly two => tree node. Returns a map className -> {kind, fields}.
  function classifyInstanceClasses(heap) {
    var classes = {}; // className -> { linkFields: Set, allFields: Set, sampleAttrs: [] }
    for (var id in heap) {
      var obj = heapGet(heap, id);
      if (!Array.isArray(obj) || obj[0] !== 'INSTANCE') continue;
      var className = obj[1];
      if (!classes[className]) classes[className] = { linkFieldCounts: {}, fieldNames: [], count: 0 };
      var info = classes[className];
      info.count++;
      for (var i = 2; i < obj.length; i++) {
        var attrName = obj[i][0];
        var attrVal = obj[i][1];
        if (info.fieldNames.indexOf(attrName) === -1) info.fieldNames.push(attrName);
        var looksLikeLink = isNullRef(attrVal) || (isRef(attrVal) && Array.isArray(heapGet(heap, refId(attrVal))) &&
          heapGet(heap, refId(attrVal))[0] === 'INSTANCE' && heapGet(heap, refId(attrVal))[1] === className);
        if (looksLikeLink) {
          info.linkFieldCounts[attrName] = (info.linkFieldCounts[attrName] || 0) + 1;
        }
      }
    }
    var result = {};
    for (var cn in classes) {
      var info = classes[cn];
      var linkFields = [];
      for (var fn in info.linkFieldCounts) {
        // require the field to look like a link on at least one instance
        linkFields.push(fn);
      }
      var kind = null;
      if (linkFields.length === 1) kind = 'list';
      else if (linkFields.length === 2) kind = 'tree';
      result[cn] = { kind: kind, linkFields: linkFields, valueFields: info.fieldNames.filter(function (f) { return linkFields.indexOf(f) === -1; }) };
    }
    return result;
  }

  function detectLinkedLists(heap, frame, allVars) {
    var classInfo = classifyInstanceClasses(heap);
    var listClassNames = Object.keys(classInfo).filter(function (cn) { return classInfo[cn].kind === 'list'; });
    if (listClassNames.length === 0) return null;

    function findListRefs(vars) {
      var out = [];
      vars.forEach(function (v) {
        if (isRef(v.val)) {
          var obj = heapGet(heap, refId(v.val));
          if (Array.isArray(obj) && obj[0] === 'INSTANCE' && listClassNames.indexOf(obj[1]) !== -1) {
            out.push({ name: v.name, id: refId(v.val) });
          }
        }
      });
      return out;
    }

    // seed chain discovery from EVERY frame (so a list whose head is only
    // still referenced in an outer/caller frame is still found in full),
    // but visual pointer labels are drawn from the current frame only
    var roots = findListRefs(allVars);
    var currentFrameRefs = findListRefs(frameVars(frame));
    if (roots.length === 0) return null;

    // group roots into distinct chains by walking `next` from each; chains
    // sharing any node are merged so e.g. dummy/tail on the same result
    // list render as one row, not two
    var nodeToChain = {}; // heap id -> chain index
    var chains = []; // [{nodeIds: [...]}]

    roots.forEach(function (r) {
      var className = heapGet(heap, r.id)[1];
      var linkField = classInfo[className].linkFields[0];
      var visited = {};
      var order = [];
      var cur = r.id;
      var guard = 0;
      while (cur !== null && cur !== undefined && !visited[cur] && guard < 10000) {
        visited[cur] = true;
        order.push(cur);
        var obj = heapGet(heap, cur);
        if (!Array.isArray(obj) || obj[0] !== 'INSTANCE') break;
        var nextVal = null;
        for (var i = 2; i < obj.length; i++) {
          if (obj[i][0] === linkField) { nextVal = obj[i][1]; break; }
        }
        if (isNullRef(nextVal)) break;
        cur = refId(nextVal);
        guard++;
      }

      // find an existing chain that shares a node with this walk
      var mergeIdx = -1;
      for (var k = 0; k < order.length; k++) {
        if (nodeToChain[order[k]] !== undefined) { mergeIdx = nodeToChain[order[k]]; break; }
      }
      var chainIdx;
      if (mergeIdx === -1) {
        chains.push({ nodeIds: order.slice(), className: className, linkField: linkField });
        chainIdx = chains.length - 1;
      } else {
        chainIdx = mergeIdx;
        var existing = chains[chainIdx].nodeIds;
        order.forEach(function (nid) { if (existing.indexOf(nid) === -1) existing.push(nid); });
      }
      order.forEach(function (nid) { nodeToChain[nid] = chainIdx; });
    });

    // visual pointer labels: current frame only, per spec
    chains.forEach(function (c) { c.pointers = []; });
    currentFrameRefs.forEach(function (r) {
      var chainIdx = nodeToChain[r.id];
      if (chainIdx !== undefined) chains[chainIdx].pointers.push({ name: r.name, id: r.id });
    });

    return { type: 'linkedlist', chains: chains, classInfo: classInfo };
  }

  function detectTrees(heap, frame, allVars) {
    var classInfo = classifyInstanceClasses(heap);
    var treeClassNames = Object.keys(classInfo).filter(function (cn) { return classInfo[cn].kind === 'tree'; });
    if (treeClassNames.length === 0) return null;

    var vars = allVars;
    var roots = [];
    vars.forEach(function (v) {
      if (isRef(v.val)) {
        var obj = heapGet(heap, refId(v.val));
        if (Array.isArray(obj) && obj[0] === 'INSTANCE' && treeClassNames.indexOf(obj[1]) !== -1) {
          roots.push({ name: v.name, id: refId(v.val) });
        }
      }
    });
    if (roots.length === 0) return null;

    // visit every reachable tree node from every root to build one combined
    // visited-set, then find true roots (in-degree 0 within that set)
    var visited = {};
    var childOf = {}; // childId -> true if referenced as a child by some visited node
    var queue = roots.map(function (r) { return r.id; });
    var order = [];
    while (queue.length) {
      var id = queue.shift();
      if (visited[id]) continue;
      visited[id] = true;
      order.push(id);
      var obj = heapGet(heap, id);
      if (!Array.isArray(obj) || obj[0] !== 'INSTANCE') continue;
      var className = obj[1];
      var linkFields = classInfo[className].linkFields;
      linkFields.forEach(function (lf) {
        for (var i = 2; i < obj.length; i++) {
          if (obj[i][0] === lf) {
            var v = obj[i][1];
            if (isRef(v)) {
              childOf[refId(v)] = true;
              if (!visited[refId(v)]) queue.push(refId(v));
            }
          }
        }
      });
    }

    var trueRoots = order.filter(function (id) { return !childOf[id]; });
    if (trueRoots.length === 0) trueRoots = [roots[0].id];

    // visual pointer labels: current frame only, per spec (and only for
    // nodes that ended up actually visited/rendered)
    var visitedSet = {};
    order.forEach(function (id) { visitedSet[id] = true; });
    var currentFramePointers = [];
    frameVars(frame).forEach(function (v) {
      if (isRef(v.val)) {
        var obj = heapGet(heap, refId(v.val));
        if (Array.isArray(obj) && obj[0] === 'INSTANCE' && treeClassNames.indexOf(obj[1]) !== -1 && visitedSet[refId(v.val)]) {
          currentFramePointers.push({ name: v.name, id: refId(v.val) });
        }
      }
    });

    return { type: 'tree', rootIds: trueRoots, visitedIds: order, classInfo: classInfo, pointers: currentFramePointers };
  }

  function looksLikeAdjacencyList(heap, val) {
    if (!isRef(val)) return false;
    var obj = heapGet(heap, refId(val));
    if (!Array.isArray(obj) || (obj[0] !== 'LIST' && obj[0] !== 'TUPLE')) return false;
    if (obj.length <= 1) return false;
    for (var i = 1; i < obj.length; i++) {
      var elt = obj[i];
      var inner = isRef(elt) ? heapGet(heap, refId(elt)) : null;
      if (!Array.isArray(inner) || (inner[0] !== 'LIST' && inner[0] !== 'TUPLE' && inner[0] !== 'SET')) return false;
      for (var j = 1; j < inner.length; j++) {
        if (typeof inner[j] !== 'number') return false;
      }
    }
    return true;
  }

  function detectGraphs(heap, frame) {
    var vars = frameVars(frame);
    var adjVar = null;
    vars.forEach(function (v) {
      if (!adjVar && looksLikeAdjacencyList(heap, v.val)) adjVar = v;
    });
    if (!adjVar) return null;

    var adjObj = heapGet(heap, refId(adjVar.val));
    var n = adjObj.length - 1;
    var adj = [];
    for (var i = 1; i < adjObj.length; i++) {
      var inner = heapGet(heap, refId(adjObj[i]));
      var neighbors = [];
      for (var j = 1; j < inner.length; j++) neighbors.push(inner[j]);
      adj.push(neighbors);
    }

    // find a visited boolean[] or set, by name convention
    var visitedVar = null;
    vars.forEach(function (v) {
      if (visitedVar) return;
      if (!/visit/i.test(v.name)) return;
      if (isRef(v.val)) {
        var obj = heapGet(heap, refId(v.val));
        if (Array.isArray(obj) && (obj[0] === 'LIST' || obj[0] === 'TUPLE')) {
          visitedVar = { name: v.name, id: refId(v.val), kind: 'array', values: obj.slice(1) };
        } else if (Array.isArray(obj) && obj[0] === 'SET') {
          visitedVar = { name: v.name, id: refId(v.val), kind: 'set', values: obj.slice(1) };
        }
      }
    });

    return { type: 'graph', n: n, adj: adj, adjVarName: adjVar.name, visited: visitedVar };
  }

  function detectArrays(heap, frame, excludeIds) {
    excludeIds = excludeIds || {};
    var vars = frameVars(frame);
    var arrays = [];
    vars.forEach(function (v) {
      if (!isRef(v.val)) return;
      var id = refId(v.val);
      if (excludeIds[id]) return;
      var obj = heapGet(heap, id);
      if (!Array.isArray(obj) || (obj[0] !== 'LIST' && obj[0] !== 'TUPLE')) return;
      var elts = obj.slice(1);
      if (elts.length === 0) return;
      var allPrimitive = elts.every(function (e) { return isPrimitive(e) || isNullRef(e); });
      if (!allPrimitive) return;
      arrays.push({ name: v.name, id: id, values: elts });
    });
    if (arrays.length === 0) return null;

    // find index-like integer variables to tag onto cells
    var indexNames = /^(i|j|k|v|w|u|mid|lo|hi|low|high|left|right|idx|index|start|end|p|q|pos)$/i;
    var indexVars = [];
    vars.forEach(function (v) {
      if (typeof v.val === 'number' && Number.isInteger(v.val) && indexNames.test(v.name)) {
        indexVars.push({ name: v.name, value: v.val });
      }
    });

    return { type: 'array', arrays: arrays, indexVars: indexVars };
  }

  function detectHashmaps(heap, frame) {
    var vars = frameVars(frame);
    var maps = [];
    vars.forEach(function (v) {
      if (!isRef(v.val)) return;
      var obj = heapGet(heap, refId(v.val));
      if (!Array.isArray(obj) || obj[0] !== 'DICT') return;
      var entries = obj.slice(1).map(function (kv) { return { key: kv[0], val: kv[1] }; });
      maps.push({ name: v.name, id: refId(v.val), entries: entries });
    });
    if (maps.length === 0) return null;
    return { type: 'hashmap', maps: maps };
  }

  function detectAll(curEntry) {
    var heap = curEntry.heap || {};
    var frame = getCurrentFrame(curEntry);
    var allVars = allPointerCandidates(curEntry);
    var shapes = [];

    var lists = detectLinkedLists(heap, frame, allVars);
    if (lists) shapes.push(lists);

    var trees = detectTrees(heap, frame, allVars);
    if (trees) shapes.push(trees);

    var graphs = detectGraphs(heap, frame);
    if (graphs) shapes.push(graphs);

    // arrays: exclude ids already claimed by the graph's adjacency list (and
    // its visited array, which the graph panel renders inline) so we don't
    // double-render the same object as both a graph and a standalone array
    var excludeIds = {};
    if (graphs) {
      var frameVarsList = frameVars(frame);
      frameVarsList.forEach(function (v) {
        if (v.name === graphs.adjVarName && isRef(v.val)) excludeIds[refId(v.val)] = true;
      });
      if (graphs.visited) excludeIds[graphs.visited.id] = true;
    }
    var arrays = detectArrays(heap, frame, excludeIds);
    if (arrays) shapes.push(arrays);

    var maps = detectHashmaps(heap, frame);
    if (maps) shapes.push(maps);

    return { shapes: shapes, heap: heap, frame: frame };
  }

  // ==========================================================================
  // Rendering: linked lists
  // ==========================================================================

  var LL_NODE_W = 90, LL_NODE_H = 40, LL_CELL_W = 45, LL_GAP = 55, LL_ROW_H = 130;

  function renderLinkedLists(svg, data, heap, prevHeap, cursor) {
    ensureArrowMarker(svg, 'svArrowNext', 'sv-edge-arrow');
    ensureArrowMarker(svg, 'svArrowPtr', 'sv-ptr-arrow-head');

    var startY = cursor.y;
    data.chains.forEach(function (chain, chainIdx) {
      var rowY = startY + chainIdx * LL_ROW_H + 55;
      var x = 20;

      // slot allocator for pointer labels: alternate above/below per node
      var nodeSlotCounts = {};

      chain.nodeIds.forEach(function (nodeId, i) {
        var obj = heapGet(heap, nodeId);
        var prevObj = prevHeap ? heapGet(prevHeap, nodeId) : null;
        var info = data.classInfo[chain.className];
        var valueFields = info ? info.valueFields : [];
        var displayVal = '?';
        var changed = false;
        if (Array.isArray(obj)) {
          var parts = [];
          for (var k = 0; k < valueFields.length; k++) {
            for (var m = 2; m < obj.length; m++) {
              if (obj[m][0] === valueFields[k]) {
                parts.push(primitiveDisplay(obj[m][1]));
                if (prevObj) {
                  for (var pm = 2; pm < prevObj.length; pm++) {
                    if (prevObj[pm][0] === valueFields[k] && JSON.stringify(prevObj[pm][1]) !== JSON.stringify(obj[m][1])) {
                      changed = true;
                    }
                  }
                }
              }
            }
          }
          displayVal = parts.join(',');
        }

        var nodeX = x;
        var g = svgEl('g', { class: 'sv-node' });
        g.appendChild(rect(nodeX, rowY, LL_CELL_W, LL_NODE_H, 'sv-node-rect sv-list-val' + (changed ? ' sv-changed' : '')));
        g.appendChild(rect(nodeX + LL_CELL_W, rowY, LL_CELL_W, LL_NODE_H, 'sv-node-rect sv-list-ptr'));
        g.appendChild(textNode(nodeX + LL_CELL_W / 2, rowY + LL_NODE_H / 2 + 5, displayVal, 'sv-node-text'));
        svg.appendChild(g);

        // record node center-top/bottom for pointer labels and edges
        chain.nodeIds[i] = nodeId; // no-op, keep id
        var nodeInfo = { x: nodeX, y: rowY, w: LL_NODE_W, h: LL_NODE_H, cx: nodeX + LL_NODE_W / 2 };
        if (!chain._pos) chain._pos = {};
        chain._pos[nodeId] = nodeInfo;

        // draw edge to next node (or a terminator)
        var isLast = (i === chain.nodeIds.length - 1);
        var arrowStartX = nodeX + LL_CELL_W + LL_CELL_W - 4;
        var arrowY = rowY + LL_NODE_H / 2;
        if (!isLast) {
          svg.appendChild(line(arrowStartX, arrowY, nodeX + LL_NODE_W + LL_GAP - 6, arrowY, 'sv-edge', 'svArrowNext'));
        } else {
          // only label it "null" if the node's own link field really is
          // null -- the walk can also end early on a cycle or truncation
          // guard, which isn't a true null terminator
          var ownNextVal = null;
          if (Array.isArray(obj)) {
            for (var mm = 2; mm < obj.length; mm++) {
              if (obj[mm][0] === chain.linkField) { ownNextVal = obj[mm][1]; break; }
            }
          }
          var terminatorLabel = isNullRef(ownNextVal) ? 'null' : '…';
          var nullX = nodeX + LL_NODE_W + 22;
          svg.appendChild(line(arrowStartX, arrowY, nullX - 14, arrowY, 'sv-edge', 'svArrowNext'));
          svg.appendChild(textNode(nullX + 8, arrowY + 5, terminatorLabel, 'sv-null-text', 'start'));
        }

        x += LL_NODE_W + LL_GAP;
      });

      // pointer labels
      (chain.pointers || []).forEach(function (ptr) {
        var pos = chain._pos[ptr.id];
        if (!pos) return;
        var count = nodeSlotCounts[ptr.id] || 0;
        nodeSlotCounts[ptr.id] = count + 1;
        var above = (count % 2 === 0);
        var offset = Math.floor(count / 2) * 18;
        var labelY = above ? rowY - 12 - offset : rowY + LL_NODE_H + 22 + offset;
        var arrowY1 = above ? labelY + 4 : labelY - 14;
        var arrowY2 = above ? rowY - 2 : rowY + LL_NODE_H + 2;
        svg.appendChild(line(pos.cx, arrowY1, pos.cx, arrowY2, 'sv-ptr-arrow', 'svArrowPtr'));
        svg.appendChild(textNode(pos.cx, labelY, ptr.name, 'sv-ptr-label'));
      });

      x = Math.max(x, 20);
      cursor.maxX = Math.max(cursor.maxX, x + 40);
    });
    cursor.y = startY + data.chains.length * LL_ROW_H + 20;
  }

  // ==========================================================================
  // Rendering: binary trees
  // ==========================================================================

  var TREE_R = 22, TREE_XGAP = 56, TREE_YGAP = 78;

  function renderTrees(svg, data, heap, prevHeap, showNulls, cursor) {
    var startY = cursor.y + TREE_R + 10;
    var slotCounter = { n: 0 };
    var positions = {}; // id -> {x,y}
    var maxDepth = { d: 0 };

    function inorder(id, depth) {
      if (id === null || id === undefined) return;
      var obj = heapGet(heap, id);
      if (!Array.isArray(obj) || obj[0] !== 'INSTANCE') return;
      var className = obj[1];
      var linkFields = data.classInfo[className].linkFields;
      var leftVal = null, rightVal = null;
      for (var i = 2; i < obj.length; i++) {
        if (obj[i][0] === linkFields[0]) leftVal = obj[i][1];
        if (obj[i][0] === linkFields[1]) rightVal = obj[i][1];
      }
      var hasLeft = isRef(leftVal);
      var hasRight = isRef(rightVal);

      if (hasLeft) inorder(refId(leftVal), depth + 1);
      else if (showNulls) slotCounter.n++; // reserve a slot for the null marker

      var slot = slotCounter.n++;
      positions[id] = { slot: slot, depth: depth };
      maxDepth.d = Math.max(maxDepth.d, depth);

      if (hasRight) inorder(refId(rightVal), depth + 1);
      else if (showNulls) slotCounter.n++;
    }

    data.rootIds.forEach(function (rootId) { inorder(rootId, 0); });

    function xOf(slot) { return 30 + slot * TREE_XGAP; }
    function yOf(depth) { return startY + depth * TREE_YGAP; }

    // draw edges first (under nodes)
    data.visitedIds.forEach(function (id) {
      if (!positions[id]) return;
      var obj = heapGet(heap, id);
      var className = obj[1];
      var linkFields = data.classInfo[className].linkFields;
      var x0 = xOf(positions[id].slot), y0 = yOf(positions[id].depth);
      linkFields.forEach(function (lf, childIdx) {
        var v = null;
        for (var i = 2; i < obj.length; i++) if (obj[i][0] === lf) v = obj[i][1];
        if (isRef(v) && positions[refId(v)]) {
          var cp = positions[refId(v)];
          svg.appendChild(line(x0, y0, xOf(cp.slot), yOf(cp.depth), 'sv-tree-edge'));
        } else if (showNulls) {
          // approximate null-slot position: immediately left/right sibling slot
          var nullSlot = childIdx === 0 ? positions[id].slot - 1 : positions[id].slot + 1;
          var nx = xOf(nullSlot), ny = yOf(positions[id].depth + 1);
          svg.appendChild(line(x0, y0, nx, ny, 'sv-tree-edge sv-tree-edge-null'));
        }
      });
    });

    // draw null markers
    if (showNulls) {
      data.visitedIds.forEach(function (id) {
        if (!positions[id]) return;
        var obj = heapGet(heap, id);
        var className = obj[1];
        var linkFields = data.classInfo[className].linkFields;
        linkFields.forEach(function (lf, childIdx) {
          var v = null;
          for (var i = 2; i < obj.length; i++) if (obj[i][0] === lf) v = obj[i][1];
          if (!isRef(v)) {
            var nullSlot = childIdx === 0 ? positions[id].slot - 1 : positions[id].slot + 1;
            var nx = xOf(nullSlot), ny = yOf(positions[id].depth + 1);
            svg.appendChild(circle(nx, ny, 10, 'sv-tree-null-marker'));
            svg.appendChild(textNode(nx, ny + 22, 'null', 'sv-null-text'));
          }
        });
      });
    }

    // draw nodes
    data.visitedIds.forEach(function (id) {
      if (!positions[id]) return;
      var obj = heapGet(heap, id);
      var prevObj = prevHeap ? heapGet(prevHeap, id) : null;
      var className = obj[1];
      var info = data.classInfo[className];
      var valStr = info.valueFields.map(function (f) {
        for (var i = 2; i < obj.length; i++) if (obj[i][0] === f) return primitiveDisplay(obj[i][1]);
        return '';
      }).join(',');
      var changed = false;
      if (prevObj) {
        info.valueFields.forEach(function (f) {
          var cur = null, prev = null;
          for (var i = 2; i < obj.length; i++) if (obj[i][0] === f) cur = obj[i][1];
          for (var i2 = 2; i2 < prevObj.length; i2++) if (prevObj[i2][0] === f) prev = prevObj[i2][1];
          if (JSON.stringify(cur) !== JSON.stringify(prev)) changed = true;
        });
      }
      var x0 = xOf(positions[id].slot), y0 = yOf(positions[id].depth);
      svg.appendChild(circle(x0, y0, TREE_R, 'sv-tree-node' + (changed ? ' sv-changed' : '')));
      svg.appendChild(textNode(x0, y0 + 5, valStr, 'sv-node-text'));
    });

    // pointer labels for any stack variable referencing a visited tree node
    var slotByPtr = {};
    (data.pointers || []).forEach(function (ptr) {
      if (!positions[ptr.id]) return;
      var x0 = xOf(positions[ptr.id].slot), y0 = yOf(positions[ptr.id].depth);
      var count = slotByPtr[ptr.id] || 0;
      slotByPtr[ptr.id] = count + 1;
      var labelY = y0 - TREE_R - 10 - count * 16;
      svg.appendChild(textNode(x0, labelY, ptr.name, 'sv-ptr-label'));
    });

    var maxSlot = 0;
    for (var k in positions) maxSlot = Math.max(maxSlot, positions[k].slot);
    cursor.maxX = Math.max(cursor.maxX, xOf(maxSlot) + 40);
    cursor.y = yOf(maxDepth.d) + TREE_YGAP + 20;
  }

  // ==========================================================================
  // Rendering: graphs
  // ==========================================================================

  function renderGraphs(svg, data, cursor) {
    ensureArrowMarker(svg, 'svArrowGraph', 'sv-graph-arrow-head');
    var n = data.n;
    var R = Math.max(60, n * 16);
    var cx = R + 40, cy = cursor.y + R + 30;
    var nodeR = 18;

    var positions = [];
    for (var i = 0; i < n; i++) {
      var angle = (2 * Math.PI * i) / n - Math.PI / 2;
      positions.push({ x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) });
    }

    // determine directed vs undirected per edge pair
    var drawn = {};
    for (var a = 0; a < n; a++) {
      data.adj[a].forEach(function (b) {
        if (b < 0 || b >= n) return;
        var key = Math.min(a, b) + '-' + Math.max(a, b);
        var reciprocal = data.adj[b] && data.adj[b].indexOf(a) !== -1;
        if (reciprocal) {
          if (drawn[key]) return;
          drawn[key] = true;
          svg.appendChild(line(positions[a].x, positions[a].y, positions[b].x, positions[b].y, 'sv-graph-edge'));
        } else {
          var dx = positions[b].x - positions[a].x, dy = positions[b].y - positions[a].y;
          var dist = Math.sqrt(dx * dx + dy * dy) || 1;
          var sx = positions[a].x + (dx / dist) * nodeR, sy = positions[a].y + (dy / dist) * nodeR;
          var ex = positions[b].x - (dx / dist) * (nodeR + 8), ey = positions[b].y - (dy / dist) * (nodeR + 8);
          svg.appendChild(line(sx, sy, ex, ey, 'sv-graph-edge sv-graph-edge-directed', 'svArrowGraph'));
        }
      });
    }

    var visitedSet = {};
    if (data.visited) {
      if (data.visited.kind === 'array') {
        data.visited.values.forEach(function (v, idx) { if (v === true) visitedSet[idx] = true; });
      } else {
        data.visited.values.forEach(function (v) { visitedSet[v] = true; });
      }
    }

    for (var j = 0; j < n; j++) {
      var cls = 'sv-graph-node' + (visitedSet[j] ? ' sv-graph-node-visited' : '');
      svg.appendChild(circle(positions[j].x, positions[j].y, nodeR, cls));
      svg.appendChild(textNode(positions[j].x, positions[j].y + 5, String(j), 'sv-node-text'));
    }

    cursor.maxX = Math.max(cursor.maxX, cx + R + 40);
    cursor.y = cy + R + 40;

    if (data.visited) {
      cursor.y = renderArrayRow(svg, data.visited.name, data.visited.values.map(function (v) { return v === true; }), [], cursor.y, cursor) ;
    }
  }

  // ==========================================================================
  // Rendering: arrays
  // ==========================================================================

  var ARR_CELL_W = 46, ARR_CELL_H = 40;

  function renderArrayRow(svg, name, values, indexVars, y, cursor, changedIndices) {
    changedIndices = changedIndices || {};
    svg.appendChild(textNode(20, y, name, 'sv-array-name', 'start'));
    var rowY = y + 10;
    var x = 20;
    var cellCenters = [];
    values.forEach(function (v, i) {
      var cls = 'sv-array-cell' + (changedIndices[i] ? ' sv-changed' : '');
      svg.appendChild(rect(x, rowY, ARR_CELL_W, ARR_CELL_H, cls, 3));
      svg.appendChild(textNode(x + ARR_CELL_W / 2, rowY + ARR_CELL_H / 2 + 5, primitiveDisplay(v), 'sv-node-text'));
      svg.appendChild(textNode(x + ARR_CELL_W / 2, rowY + ARR_CELL_H + 16, String(i), 'sv-array-index'));
      cellCenters.push(x + ARR_CELL_W / 2);
      x += ARR_CELL_W;
    });

    // index tags above the row
    var tagRows = {};
    indexVars.forEach(function (iv) {
      if (iv.value < 0 || iv.value >= cellCenters.length) return;
      var count = tagRows[iv.value] || 0;
      tagRows[iv.value] = count + 1;
      var tagY = rowY - 10 - count * 18;
      svg.appendChild(line(cellCenters[iv.value], tagY + 4, cellCenters[iv.value], rowY - 2, 'sv-ptr-arrow'));
      svg.appendChild(textNode(cellCenters[iv.value], tagY, iv.name, 'sv-ptr-label'));
    });

    cursor.maxX = Math.max(cursor.maxX, x + 20);
    return rowY + ARR_CELL_H + 40;
  }

  function renderArrays(svg, data, heap, prevHeap, cursor) {
    data.arrays.forEach(function (arr) {
      var prevObj = prevHeap ? heapGet(prevHeap, arr.id) : null;
      var changedIndices = {};
      if (prevObj && Array.isArray(prevObj)) {
        arr.values.forEach(function (v, i) {
          var pv = prevObj[i + 1];
          if (pv !== undefined && JSON.stringify(pv) !== JSON.stringify(v)) changedIndices[i] = true;
        });
      }
      cursor.y = renderArrayRow(svg, arr.name, arr.values, data.indexVars, cursor.y, cursor, changedIndices);
    });
  }

  // ==========================================================================
  // Rendering: hashmaps
  // ==========================================================================

  function renderHashmaps(svg, data, cursor) {
    data.maps.forEach(function (m) {
      svg.appendChild(textNode(20, cursor.y, m.name, 'sv-array-name', 'start'));
      var y = cursor.y + 12;
      m.entries.forEach(function (e) {
        svg.appendChild(rect(20, y, 90, 32, 'sv-bucket-key', 3));
        svg.appendChild(textNode(65, y + 21, primitiveDisplay(e.key), 'sv-node-text'));
        svg.appendChild(line(110, y + 16, 128, y + 16, 'sv-edge'));
        svg.appendChild(rect(128, y, 120, 32, 'sv-bucket-val', 3));
        svg.appendChild(textNode(188, y + 21, isPrimitive(e.val) ? primitiveDisplay(e.val) : '(object)', 'sv-node-text'));
        y += 38;
      });
      cursor.maxX = Math.max(cursor.maxX, 260);
      cursor.y = y + 20;
    });
  }

  // ==========================================================================
  // Call stack table
  // ==========================================================================

  function splitFuncName(funcName) {
    var idx = funcName.lastIndexOf(':');
    if (idx === -1) return { name: funcName, line: '' };
    var maybeLine = funcName.slice(idx + 1);
    if (/^\d+$/.test(maybeLine)) return { name: funcName.slice(0, idx), line: maybeLine };
    return { name: funcName, line: '' };
  }

  function shortValueDisplay(v, heap) {
    if (isPrimitive(v) || isNullRef(v)) return primitiveDisplay(v);
    if (isRef(v)) {
      var obj = heapGet(heap, refId(v));
      if (Array.isArray(obj)) {
        if (obj[0] === 'INSTANCE') return obj[1] + '#' + refId(v);
        if (obj[0] === 'LIST') return 'list[' + (obj.length - 1) + ']#' + refId(v);
        if (obj[0] === 'DICT') return 'dict#' + refId(v);
        return obj[0].toLowerCase() + '#' + refId(v);
      }
      return 'ref#' + refId(v);
    }
    return '(value)';
  }

  function renderCallStack(table, curEntry) {
    var heap = curEntry.heap || {};
    var frames = (curEntry.stack_to_render || []).filter(function (f) { return !f.is_zombie; });
    table.innerHTML = '';
    if (frames.length === 0) {
      var globalRow = document.createElement('tr');
      globalRow.className = 'sv-callstack-row-current';
      globalRow.innerHTML = '<td colspan="6">&lt;module&gt; (global scope)</td>';
      table.appendChild(globalRow);
      return;
    }

    // union of column variable names, deepest frame first, capped at 4
    var colNames = [];
    for (var i = frames.length - 1; i >= 0; i--) {
      var names = frames[i].ordered_varnames || [];
      names.forEach(function (n) {
        if (n !== '__return__' && colNames.indexOf(n) === -1 && colNames.length < 4) colNames.push(n);
      });
    }

    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    headRow.appendChild(document.createElement('th')).textContent = 'method call';
    headRow.appendChild(document.createElement('th')).textContent = 'line';
    colNames.forEach(function (n) {
      headRow.appendChild(document.createElement('th')).textContent = n;
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    frames.forEach(function (frame, i) {
      var split = splitFuncName(frame.func_name);
      var tr = document.createElement('tr');
      if (i === frames.length - 1) tr.className = 'sv-callstack-row-current';
      var callTd = document.createElement('td');
      callTd.textContent = split.name;
      tr.appendChild(callTd);
      var lineTd = document.createElement('td');
      lineTd.textContent = split.line || String(frame.line || '');
      tr.appendChild(lineTd);
      colNames.forEach(function (n) {
        var td = document.createElement('td');
        var v = frame.encoded_locals[n];
        td.textContent = (v === undefined) ? '—' : shortValueDisplay(v, heap);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  // ==========================================================================
  // Output line
  // ==========================================================================

  function renderOutputLine(el, curEntry) {
    var out = curEntry.stdout || '';
    el.textContent = 'Output — ' + (out.length ? JSON.stringify(out) : '(none yet)');
  }

  // ==========================================================================
  // Main render pipeline
  // ==========================================================================

  var lastArgs = null; // for re-render on showNulls toggle

  function doRender(curEntry, curInstr, curTrace) {
    var d = ensureDOM();
    if (!d) return; // classic view not mounted yet, nothing to attach to

    renderCallStack(d.callStackTable, curEntry);
    renderOutputLine(d.outputLine, curEntry);

    var detection = detectAll(curEntry);
    var heap = detection.heap;
    var prevHeap = (typeof curInstr === 'number' && curTrace && curInstr > 0 && curTrace[curInstr - 1]) ?
      curTrace[curInstr - 1].heap : null;

    d.svg.innerHTML = '';
    if (detection.shapes.length === 0) {
      d.message.style.display = '';
      d.message.textContent = 'No recognized structure at this step — see classic view below.';
      d.svg.setAttribute('height', 0);
      return;
    }
    d.message.style.display = 'none';

    var cursor = { y: 20, maxX: 200 };
    detection.shapes.forEach(function (shape) {
      if (shape.type === 'linkedlist') renderLinkedLists(d.svg, shape, heap, prevHeap, cursor);
      else if (shape.type === 'tree') renderTrees(d.svg, shape, heap, prevHeap, state.showNulls, cursor);
      else if (shape.type === 'graph') renderGraphs(d.svg, shape, cursor);
      else if (shape.type === 'array') renderArrays(d.svg, shape, heap, prevHeap, cursor);
      else if (shape.type === 'hashmap') renderHashmaps(d.svg, shape, cursor);
    });

    d.svg.setAttribute('width', Math.max(cursor.maxX, 300));
    d.svg.setAttribute('height', Math.max(cursor.y, 60));
    d.svg.setAttribute('viewBox', '0 0 ' + Math.max(cursor.maxX, 300) + ' ' + Math.max(cursor.y, 60));
  }

  function rerenderLast() {
    if (lastArgs) {
      try { doRender(lastArgs[0], lastArgs[1], lastArgs[2]); } catch (e) { reportError(e); }
    }
  }

  function reportError(e) {
    if (window.console && console.error) console.error('StructureView error:', e);
    if (dom && dom.message) {
      dom.message.style.display = '';
      dom.message.textContent = 'Structure View hit an internal error and stopped updating (see console) — the classic view below is unaffected.';
      if (dom.svg) dom.svg.innerHTML = '';
    }
  }

  var StructureView = {
    update: function (curEntry, curInstr, curTrace) {
      try {
        if (!curEntry) return;
        lastArgs = [curEntry, curInstr, curTrace];
        doRender(curEntry, curInstr, curTrace);
      } catch (e) {
        reportError(e);
      }
    },
  };

  window.StructureView = StructureView;
})();
