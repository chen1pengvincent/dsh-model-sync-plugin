window.__ModuleLoader__.load({
  id: "dsh-model-sync",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = "/model-sync/api";

    const MERGED_PRIMARY_PROVIDERS = new Set(["opencode-go", "opencode"]);
    const SIBLING_SUFFIXES = ["chat", "messages", "responses"];
    const MODEL_ROUTE_SEP = "\u0000";

    const modelRouteKey = (provider, model) => `${provider}${MODEL_ROUTE_SEP}${model}`;

    function siblingInfo(providerId) {
      if (typeof providerId !== "string") return undefined;
      for (let order = 0; order < SIBLING_SUFFIXES.length; order += 1) {
        const suffix = `-${SIBLING_SUFFIXES[order]}`;
        if (!providerId.endsWith(suffix)) continue;
        const primary = providerId.slice(0, -suffix.length);
        if (MERGED_PRIMARY_PROVIDERS.has(primary)) return { primary, order };
      }
      return undefined;
    }

    function mergeModelGroups(groups) {
      const list = Array.isArray(groups) ? groups : [];
      const byId = new Map();
      for (const group of list) {
        if (group !== null && typeof group === "object" && typeof group.id === "string") byId.set(group.id, group);
      }
      const plans = new Map();
      for (const group of list) {
        const info = siblingInfo(group?.id);
        if (info === undefined) continue;
        let plan = plans.get(info.primary);
        if (plan === undefined) {
          const displayName = typeof group.name === "string" ? group.name.split(" · ")[0] : "";
          plan = {
            primary: byId.get(info.primary),
            name: displayName.length > 0 ? displayName : info.primary,
            siblings: [],
          };
          plans.set(info.primary, plan);
        }
        plan.siblings.push({ group, order: info.order });
      }
      if (plans.size === 0) {
        return { changed: false, groups: list, providerAlias: new Map(), modelRoutes: new Map(), primaryNames: new Map() };
      }
      for (const plan of plans.values()) plan.siblings.sort((left, right) => left.order - right.order);
      const providerAlias = new Map();
      const modelRoutes = new Map();
      const primaryNames = new Map();
      const merged = [];
      const created = new Set();
      const appendModels = (target, seen, models, visibleProvider, routeProvider) => {
        for (const model of Array.isArray(models) ? models : []) {
          if (model === null || typeof model !== "object" || typeof model.id !== "string" || seen.has(model.id)) continue;
          seen.add(model.id);
          target.push(model);
          if (routeProvider !== undefined) modelRoutes.set(modelRouteKey(visibleProvider, model.id), routeProvider);
        }
      };
      for (const group of list) {
        if (group === null || typeof group !== "object") {
          merged.push(group);
          continue;
        }
        const info = siblingInfo(group.id);
        if (info !== undefined && plans.has(info.primary)) {
          providerAlias.set(group.id, info.primary);
          const plan = plans.get(info.primary);
          const primary = plan.primary;
          if (primary === undefined && !created.has(info.primary)) {
            created.add(info.primary);
            const seen = new Set();
            const models = [];
            for (const entry of plan.siblings) appendModels(models, seen, entry.group.models, info.primary, entry.group.id);
            if (models.length > 0) {
              merged.push({ id: info.primary, name: plan.name, models });
              primaryNames.set(info.primary, plan.name);
            }
          }
          continue;
        }
        const plan = plans.get(group.id);
        if (plan === undefined) {
          merged.push(group);
          continue;
        }
        const seen = new Set();
        const models = [];
        appendModels(models, seen, group.models, group.id, undefined);
        for (const entry of plan.siblings) appendModels(models, seen, entry.group.models, group.id, entry.group.id);
        merged.push({ ...group, models });
        primaryNames.set(group.id, typeof group.name === "string" && group.name.length > 0 ? group.name : group.id);
      }
      return { changed: true, groups: merged, providerAlias, modelRoutes, primaryNames };
    }

    function remapSelection(selection, providerAlias) {
      if (selection === null || typeof selection !== "object") return selection;
      const primary = providerAlias.get(selection.provider);
      return primary === undefined ? selection : { ...selection, provider: primary };
    }

    function mergeFailures(failures, providerAlias, primaryNames) {
      if (!Array.isArray(failures)) return failures;
      const entries = new Map();
      let order = 0;
      let changed = false;
      for (const failure of failures) {
        if (failure === null || typeof failure !== "object") continue;
        const inferred = siblingInfo(failure.id);
        const primary = providerAlias.get(failure.id) ?? inferred?.primary;
        if (primary === undefined) {
          if (!entries.has(failure.id)) entries.set(failure.id, { order: order++, failure });
          continue;
        }
        changed = true;
        const fallbackName = typeof failure.name === "string" ? failure.name.split(" · ")[0] : "";
        const mapped = {
          ...failure,
          id: primary,
          name: primaryNames.get(primary) ?? (fallbackName.length > 0 ? fallbackName : primary),
        };
        const existing = entries.get(primary);
        if (existing === undefined) entries.set(primary, { order: order++, failure: mapped });
        else if (failure.id === primary) existing.failure = mapped;
      }
      if (!changed) return failures;
      return [...entries.values()].sort((left, right) => left.order - right.order).map((entry) => entry.failure);
    }

    function transformDirectorySnapshot(snapshot) {
      if (snapshot === null || typeof snapshot !== "object") return snapshot;
      const plan = mergeModelGroups(snapshot.groups);
      const failures = mergeFailures(snapshot.failures, plan.providerAlias, plan.primaryNames);
      if (!plan.changed && failures === snapshot.failures) return snapshot;
      const transformed = { ...snapshot };
      if (plan.changed) {
        transformed.groups = plan.groups;
        transformed.current = remapSelection(snapshot.current, plan.providerAlias);
        transformed.pending = remapSelection(snapshot.pending, plan.providerAlias);
        if (snapshot.default !== undefined) transformed.default = remapSelection(snapshot.default, plan.providerAlias);
      }
      if (failures !== snapshot.failures) transformed.failures = failures;
      return transformed;
    }

    function resolveModelSelection(snapshot, selection) {
      if (selection === null || typeof selection !== "object") return selection;
      const plan = mergeModelGroups(snapshot?.groups);
      if (!plan.changed) return selection;
      const actual = plan.modelRoutes.get(modelRouteKey(selection.provider, selection.model));
      return actual === undefined ? selection : { ...selection, provider: actual };
    }

    function createMergedDirectory(directory) {
      if (directory === null || typeof directory !== "object") return directory;
      const sourceStore = directory.store;
      if (sourceStore === null || typeof sourceStore !== "object"
        || typeof sourceStore.getSnapshot !== "function" || typeof sourceStore.subscribe !== "function"
        || typeof directory.load !== "function" || typeof directory.select !== "function") return directory;
      const safeTransform = (value) => {
        try {
          return transformDirectorySnapshot(value);
        } catch {
          return value;
        }
      };
      let sourceSnapshot = sourceStore.getSnapshot();
      let mergedSnapshot = safeTransform(sourceSnapshot);
      const listeners = new Set();
      const refresh = () => {
        const next = sourceStore.getSnapshot();
        if (next === sourceSnapshot) return;
        sourceSnapshot = next;
        mergedSnapshot = safeTransform(next);
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
          }
        }
      };
      const unsubscribe = typeof sourceStore.subscribe === "function" ? sourceStore.subscribe(refresh) : undefined;
      const load = async () => {
        const value = await directory.load();
        refresh();
        return value === undefined ? value : safeTransform(value);
      };
      const select = async (selection) => {
        let actual = selection;
        try {
          actual = resolveModelSelection(sourceSnapshot, selection);
        } catch {
          actual = selection;
        }
        try {
          return await directory.select(actual);
        } finally {
          refresh();
        }
      };
      const store = {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSnapshot() {
          return mergedSnapshot;
        },
      };
      const wrapper = new Proxy(directory, {
        get(target, property) {
          if (property === "store") return store;
          if (property === "load") return load;
          if (property === "select") return select;
          if (property === "dispose") {
            return () => {
              if (typeof unsubscribe === "function") unsubscribe();
              listeners.clear();
              return typeof target.dispose === "function" ? target.dispose() : undefined;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, property, value) {
          return Reflect.set(target, property, value);
        },
      });
      return wrapper;
    }

    function installModelGroupMerge(ctx) {
      if (typeof ctx?.inject !== "function") return;
      ctx.inject(["modelDirectories"], (scope) => {
        const service = scope.get?.("modelDirectories");
        if (service === undefined || typeof service.directoryFor !== "function") return;
        const original = service.directoryFor;
        if (original.__dshModelSyncMerged === true) return;
        const directories = new WeakMap();
        const mergedDirectoryFor = function mergedDirectoryFor(sessionId) {
          const directory = original.call(this, sessionId);
          if (directory === null || typeof directory !== "object") return directory;
          let wrapper = directories.get(directory);
          if (wrapper === undefined) {
            try {
              wrapper = createMergedDirectory(directory);
            } catch {
              wrapper = directory;
            }
            directories.set(directory, wrapper);
          }
          return wrapper;
        };
        try {
          mergedDirectoryFor.__dshModelSyncMerged = true;
        } catch {
          return;
        }
        try {
          service.directoryFor = mergedDirectoryFor;
        } catch {
          return;
        }
        const dispose = () => {
          if (service.directoryFor === mergedDirectoryFor) service.directoryFor = original;
        };
        if (typeof ctx.effect === "function") ctx.effect(() => dispose, "dsh-model-sync: merge model groups");
      });
    }

    let reactDom;
    try {
      reactDom = require("react-dom");
    } catch {
      reactDom = undefined;
    }
    const createPortal = typeof reactDom?.createPortal === "function" ? reactDom.createPortal : undefined;

    let primitives;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch {
      primitives = undefined;
    }

    const svgIcon = (size, paths) =>
      h(
        "svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", strokeWidth: 1 },
        paths.map((d, index) => h("path", { key: index, d, stroke: "currentColor" })),
      );

    const FallbackChevronRight = (props) => svgIcon(props?.size ?? 14, ["M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4"]);
    const FallbackChevronDown = (props) => svgIcon(props?.size ?? 14, ["M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6"]);
    const FallbackTrash = (props) =>
      svgIcon(props?.size ?? 16, [
        "M1.28149 3.88831H14.7187",
        "M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833",
        "M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831",
        "M6.44946 6.98926V11.1238",
        "M9.55054 6.98926V11.1238",
      ]);

    const ChevronRightIcon = primitives?.IconChevronRightOutlineRegular ?? FallbackChevronRight;
    const ChevronDownIcon = primitives?.IconChevronDownOutlineRegular ?? FallbackChevronDown;
    const TrashIcon = primitives?.IconTrashOutlineRegular ?? FallbackTrash;
    const Checkbox = primitives?.Checkbox;
    const Modal = primitives?.Modal;
    const Button = primitives?.Button;
    const Toast = primitives?.Toast;
    const WarningIcon = primitives?.IconWarningOutlineRegular;

    const ROUTE_LABELS = {
      "deepseek-official": "DeepSeek",
      "opencode-go": "OpenCode Go",
      "opencode-go-messages": "OpenCode Go · Anthropic",
      "opencode-go-responses": "OpenCode Go · Responses",
      "opencode-go-chat": "OpenCode Go · Chat",
      opencode: "OpenCode",
      "opencode-chat": "OpenCode · Chat",
      "opencode-messages": "OpenCode · Anthropic",
      "opencode-responses": "OpenCode · Responses",
      openrouter: "OpenRouter",
      "kimi-coding": "Kimi Coding",
    };

    const label = (provider) => ROUTE_LABELS[provider] ?? provider;
    const modelName = (item) => (item.name && item.name.length > 0 ? item.name : item.id);

    const AUTO_VALUE_HINT = "由插件自动获取";

    function formatTime(value) {
      if (typeof value !== "number") return "—";
      try {
        return new Date(value).toLocaleString();
      } catch {
        return String(value);
      }
    }

    async function api(path, init) {
      const res = await fetch(`${API}${path}`, {
        headers: { "content-type": "application/json" },
        ...init,
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    }

    function formatUpdateTime(value) {
      if (typeof value !== "number" || value <= 0) return "";
      const diff = Date.now() - value;
      if (diff < 60 * 1000) return "刚刚";
      if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`;
      if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
      try {
        return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      } catch {
        return "";
      }
    }

    const SIBLING_CARD_NAME = /^OpenCode(?: Go)? · (?:Chat Completions|Anthropic Messages|Responses)$/;
    const HIDDEN_MARK = "data-dsh-model-sync-hidden";

    function collectSiblingNames(payload) {
      const names = new Set();
      for (const route of payload?.routes ?? []) {
        for (const sibling of route.siblings ?? []) {
          if (typeof sibling.displayName === "string" && sibling.displayName.length > 0) names.add(sibling.displayName);
        }
      }
      return names;
    }

    function installSiblingCardHider() {
      let hiddenNames = new Set();
      let lastRefresh = 0;
      let queued = false;
      let disposed = false;
      const touched = new Set();

      const scan = () => {
        for (const card of document.querySelectorAll('li[class*="rowCard"]')) {
          const nameEl = card.querySelector('span[class*="rowName"]');
          if (nameEl === null) continue;
          const name = (nameEl.textContent ?? "").trim();
          if (hiddenNames.has(name) || SIBLING_CARD_NAME.test(name)) {
            card.setAttribute(HIDDEN_MARK, "1");
            card.style.display = "none";
            touched.add(card);
          } else if (card.getAttribute(HIDDEN_MARK) === "1") {
            card.removeAttribute(HIDDEN_MARK);
            card.style.display = "";
            touched.delete(card);
          }
        }
      };

      const refreshNames = async () => {
        lastRefresh = Date.now();
        try {
          hiddenNames = collectSiblingNames(await api("/managed"));
        } catch {
          /* host API unavailable: keep whatever names we already know */
        }
      };

      const run = () => {
        queued = false;
        if (disposed) return;
        scan();
        if (Date.now() - lastRefresh > 15000) {
          void refreshNames().then(() => {
            if (!disposed) scan();
          });
        }
      };

      const observer = new MutationObserver(() => {
        if (queued || disposed) return;
        queued = true;
        queueMicrotask(run);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      void refreshNames().then(() => scan());

      return () => {
        disposed = true;
        observer.disconnect();
        for (const card of touched) {
          card.removeAttribute(HIDDEN_MARK);
          if (card.style.display === "none") card.style.display = "";
        }
        touched.clear();
      };
    }

    /**
     * The models page's own CSS-module class prefix, discovered from any
     * rendered card (`_<hash>_rowCard`). Reusing the live prefix means the
     * managed rows are styled by the official stylesheet itself instead of a
     * hand-copied replica, so they stay identical across DSH releases. When the
     * prefix cannot be found the panel hides rather than rendering unstyled.
     */
    function officialClassPrefix() {
      for (const element of document.querySelectorAll('[class*="rowCard"]')) {
        for (const token of element.classList) {
          if (token.length > "rowCard".length && token.endsWith("rowCard")) return token.slice(0, -"rowCard".length);
        }
      }
      return undefined;
    }

    /** Spell a stored capacity the way the official editor does (K = 1000, M = 1000000). */
    function formatCapacity(value) {
      if (!Number.isInteger(value) || value <= 0) return String(value);
      if (value % 1e6 === 0) return `${String(value / 1e6)}M`;
      if (value % 1e3 === 0) return `${String(value / 1e3)}K`;
      return String(value);
    }

    function ManagedPanel(props) {
      const providerId = props !== undefined && props.provider !== undefined ? props.provider.provider : undefined;
      const active = providerId === "opencode-go" || providerId === "opencode";
      const [payload, setPayload] = useState(undefined);
      const [error, setError] = useState("");
      const [expanded, setExpanded] = useState(() => new Set());
      const [listTarget, setListTarget] = useState(null);
      const [listVersion, setListVersion] = useState(0);
      const [confirm, setConfirm] = useState(null);
      const [toast, setToast] = useState(null);
      const [staged, setStaged] = useState([]);
      const anchorRef = useRef(null);
      const wrapperRef = useRef(null);
      const stagedRef = useRef([]);
      const saveClickedRef = useRef(false);
      const toastSeqRef = useRef(0);
      const loadGenRef = useRef(0);
      const lastCountRef = useRef(-1);

      const load = useCallback(async () => {
        const generation = loadGenRef.current + 1;
        loadGenRef.current = generation;
        try {
          const next = await api("/managed");
          if (generation !== loadGenRef.current) return null;
          setPayload(next);
          setError("");
          return null;
        } catch (err) {
          if (generation !== loadGenRef.current) return null;
          setError(err.message);
          return err.message;
        }
      }, []);

      const applyStaged = useCallback((next) => {
        stagedRef.current = next;
        setStaged(next);
      }, []);

      const pushToast = useCallback((text) => {
        toastSeqRef.current += 1;
        setToast({ seq: toastSeqRef.current, text });
      }, []);

      const commitStaged = useCallback(async () => {
        const items = stagedRef.current;
        if (items.length === 0) return;
        const committed = new Set(items.map((item) => `${item.provider}:${item.modelId}`));
        try {
          const outcome = await api("/remove", {
            method: "POST",
            body: JSON.stringify({ removals: items.map((item) => ({ provider: item.provider, modelId: item.modelId })) }),
          });
          const missing = (outcome.results ?? []).filter((entry) => entry.removed === false);
          if (missing.length > 0) {
            const named = missing.map((entry) => {
              const item = items.find((candidate) => candidate.provider === entry.provider && candidate.modelId === entry.modelId);
              return item !== undefined ? item.name : `${entry.provider}/${entry.modelId}`;
            });
            const subject = named.length === 1 ? `移除「${named[0]}」` : `移除「${named[0]}」等 ${named.length} 个模型`;
            pushToast(`${subject}失败：未找到该模型`);
          }
        } catch (err) {
          const first = items[0];
          const subject = items.length > 1 ? `移除「${first.name}」等 ${items.length} 个模型` : `移除「${first.name}」`;
          pushToast(`${subject}失败：${err.message}`);
        }
        const failure = await load();
        applyStaged(stagedRef.current.filter((item) => !committed.has(`${item.provider}:${item.modelId}`)));
        if (failure !== null) pushToast(`删除已提交，但列表刷新失败：${failure}`);
        window.dispatchEvent(new Event("dsh-model-sync:updated"));
      }, [applyStaged, load, pushToast]);

      const discardStaged = useCallback(() => {
        if (stagedRef.current.length === 0) return;
        applyStaged([]);
      }, [applyStaged]);

      useEffect(() => {
        if (!active) return undefined;
        void load();
        const onUpdate = () => {
          void load();
        };
        window.addEventListener("dsh-model-sync:updated", onUpdate);
        return () => window.removeEventListener("dsh-model-sync:updated", onUpdate);
      }, [active, load]);

      /**
       * The official editor mounts only while the card is being edited; this
       * effect mirrors its draft semantics. The managed rows are portalled into
       * a wrapper appended to the official model list, a capture listener on
       * the card watches the official footer buttons so a 保存 can be told from
       * a 取消, and the editor's mount/unmount drives commit or discard of the
       * staged deletions.
       */
      useEffect(() => {
        if (!active) return undefined;
        const anchor = anchorRef.current;
        const card = anchor === null ? null : anchor.closest('li[class*="rowCard"]');
        if (card === null) return undefined;
        let wrapper = null;
        let editorEl = null;
        let editorOpen = false;

        const tokenOf = (element, suffix) => {
          if (element === null || element === undefined) return undefined;
          for (const token of element.classList) {
            if (token.length > suffix.length && token.endsWith(suffix)) return token;
          }
          return undefined;
        };
        const findEditor = () => {
          let fallback = null;
          for (const element of card.querySelectorAll("div, section")) {
            if (tokenOf(element, "editor") === undefined) continue;
            if (fallback === null) fallback = element;
            if (element.querySelector("[class*='editorActions']") !== null) return element;
          }
          return fallback;
        };
        const findList = () => {
          for (const element of card.querySelectorAll("[class*='modelList']")) {
            if (element.getAttribute("data-dsh-model-sync") === "list") continue;
            if (tokenOf(element, "modelList") !== undefined) return element;
          }
          return null;
        };
        const ensureWrapper = (list) => {
          const prefixNow = officialClassPrefix();
          if (prefixNow === undefined) return null;
          if (wrapper === null || wrapper.parentElement !== list) {
            wrapper = document.createElement("div");
            wrapper.className = `${prefixNow}modelList`;
            wrapper.setAttribute("data-dsh-model-sync", "list");
            wrapperRef.current = wrapper;
            list.appendChild(wrapper);
          } else if (list.lastElementChild !== wrapper) {
            list.appendChild(wrapper);
          }
          return wrapper;
        };
        const onClickCapture = (event) => {
          const button = event.target instanceof Element ? event.target.closest("button") : null;
          const actions = button === null ? null : button.closest("[class*='editorActions']");
          const token =
            button !== null && actions !== null && card.contains(actions) && editorEl !== null && editorEl.contains(button)
              ? tokenOf(button, "primaryButton") ?? tokenOf(button, "secondaryButton")
              : undefined;
          saveClickedRef.current = token !== undefined && token.endsWith("primaryButton");
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") saveClickedRef.current = false;
        };
        const scan = () => {
          const editor = findEditor();
          const open = editor !== null;
          if (open !== editorOpen) {
            editorOpen = open;
            if (open) {
              saveClickedRef.current = false;
              void load();
            } else if (saveClickedRef.current) {
              saveClickedRef.current = false;
              void commitStaged();
            } else {
              discardStaged();
            }
          }
          editorEl = editor;
          const list = editor === null ? null : findList();
          if (list === null) {
            setListTarget(null);
            return;
          }
          const next = ensureWrapper(list);
          if (next === null) {
            setListTarget(null);
            return;
          }
          const count = [...list.children].indexOf(next);
          if (count !== lastCountRef.current) {
            lastCountRef.current = count;
            setListVersion((value) => value + 1);
          }
          setListTarget((previous) => (previous === next ? previous : next));
        };
        const observer = new MutationObserver(scan);
        observer.observe(card, { childList: true, subtree: true });
        document.addEventListener("click", onClickCapture, true);
        document.addEventListener("keydown", onKeyDown, true);
        scan();
        return () => {
          observer.disconnect();
          document.removeEventListener("click", onClickCapture, true);
          document.removeEventListener("keydown", onKeyDown, true);
          if (wrapper !== null && wrapper.parentElement !== null) wrapper.parentElement.removeChild(wrapper);
          wrapperRef.current = null;
          saveClickedRef.current = false;
        };
      }, [active, load, commitStaged, discardStaged]);

      const anchor = h("span", { ref: anchorRef, hidden: true });
      if (!active) return null;
      const prefix = officialClassPrefix();
      const cls = (name) => (prefix === undefined ? name : `${prefix}${name}`);
      const route = (payload?.routes ?? []).find((entry) => entry.provider === providerId);
      const allRows = route === undefined ? [] : route.siblings.flatMap((sibling) => sibling.models.map((model) => ({ sibling, model })));
      const stagedKeys = new Set(staged.map((entry) => `${entry.provider}:${entry.modelId}`));
      const rows = allRows.filter(({ sibling, model }) => !stagedKeys.has(`${sibling.provider}:${model.id}`));
      const officialCount =
        wrapperRef.current !== null && wrapperRef.current.parentElement !== null
          ? [...wrapperRef.current.parentElement.children].indexOf(wrapperRef.current)
          : 0;
      void listVersion;

      const toggle = (key) => {
        setExpanded((current) => {
          const next = new Set(current);
          if (!next.delete(key)) next.add(key);
          return next;
        });
      };

      const openConfirm = (sibling, model) => {
        const name = model.name !== undefined && model.name.length > 0 ? model.name : model.id;
        const entry = { provider: sibling.provider, modelId: model.id, name };
        if (Modal === undefined || Button === undefined) {
          if (!window.confirm(`移除「${name}」？移除后它不再出现在 DSH 的模型选择中；之后可在「设置 → 模型更新」重新添加。`)) return;
          applyStaged([...stagedRef.current, entry]);
          return;
        }
        setConfirm(entry);
      };

      const modalNode =
        Modal === undefined
          ? null
          : h(
              Modal,
              {
                open: confirm !== null,
                onClose: () => setConfirm(null),
                title: "移除模型",
                closeLabel: "关闭",
                description:
                  confirm === null ? "" : `移除「${confirm.name}」？移除后它不再出现在 DSH 的模型选择中；之后可在「设置 → 模型更新」重新添加。`,
                className: cls("deleteDialog"),
                footer:
                  confirm === null
                    ? null
                    : h(
                        React.Fragment,
                        null,
                        h(Button, { variant: "outline", "data-modal-autofocus": true, onClick: () => setConfirm(null) }, "取消"),
                        h(
                          Button,
                          {
                            variant: "outline",
                            className: cls("deleteConfirm"),
                            onClick: () => {
                              const entry = confirm;
                              setConfirm(null);
                              if (stagedRef.current.some((item) => item.provider === entry.provider && item.modelId === entry.modelId)) return;
                              applyStaged([...stagedRef.current, entry]);
                            },
                          },
                          "移除",
                        ),
                      ),
              },
              null,
            );

      const toastNode =
        Toast === undefined || toast === null
          ? null
          : h(Toast, {
              key: toast.seq,
              text: toast.text,
              icon: WarningIcon === undefined ? undefined : h(WarningIcon, {}),
              holdMs: 6000,
              onDone: () => {
                const seq = toast.seq;
                setToast((current) => (current !== null && current.seq === seq ? null : current));
              },
            });

      const toastFallbackNode = Toast !== undefined || toast === null ? null : h("p", { className: cls("error") }, toast.text);

      return h(
        React.Fragment,
        null,
        anchor,
        listTarget === null || createPortal === undefined || prefix === undefined
          ? null
          : createPortal(
              h(
                React.Fragment,
                null,
                rows.map(({ sibling, model }, index) => {
                  const key = `${sibling.provider}:${model.id}`;
                  const position = officialCount + index + 1;
                  const isOpen = expanded.has(key);
                  const modalities = Array.isArray(model.input) && model.input.length > 0 ? model.input : ["text"];
                  return h(
                    "div",
                    { key, className: cls("modelEntry") },
                    h(
                      "div",
                      { className: cls("modelRow") },
                      h("input", {
                        className: cls("input"),
                        type: "text",
                        value: model.id,
                        readOnly: true,
                        placeholder: AUTO_VALUE_HINT,
                        title: AUTO_VALUE_HINT,
                        "aria-label": `模型 ID ${position}`,
                      }),
                      h("input", {
                        className: cls("input"),
                        type: "text",
                        value: typeof model.name === "string" ? model.name : "",
                        readOnly: true,
                        placeholder: AUTO_VALUE_HINT,
                        title: AUTO_VALUE_HINT,
                        "aria-label": `显示名称 ${position}`,
                      }),
                      h(
                        "button",
                        {
                          type: "button",
                          className: cls("iconButton"),
                          "aria-label": `模型选项 ${position}`,
                          "aria-expanded": isOpen,
                          title: "模型选项",
                          onClick: () => toggle(key),
                        },
                        isOpen ? h(ChevronDownIcon, {}) : h(ChevronRightIcon, {}),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          className: `${cls("iconButton")} ${cls("iconButtonDanger")}`,
                          "aria-label": `删除模型 ${position}`,
                          title: "删除模型",
                          onClick: () => openConfirm(sibling, model),
                        },
                        h(TrashIcon, { size: 14 }),
                      ),
                    ),
                    isOpen
                      ? h(
                          "div",
                          { className: cls("modelAdvanced") },
                          h(
                            "label",
                            { className: cls("modelField") },
                            h("span", { className: cls("modelFieldLabel") }, "上下文窗口"),
                            h("input", {
                              className: cls("input"),
                              type: "text",
                              inputMode: "numeric",
                              value: model.contextWindow === undefined ? "" : formatCapacity(model.contextWindow),
                              readOnly: true,
                              placeholder: AUTO_VALUE_HINT,
                              title: AUTO_VALUE_HINT,
                              "aria-label": `上下文窗口 ${position}`,
                            }),
                          ),
                          h(
                            "label",
                            { className: cls("modelField") },
                            h("span", { className: cls("modelFieldLabel") }, "最大输出 token 数"),
                            h("input", {
                              className: cls("input"),
                              type: "text",
                              inputMode: "numeric",
                              value: model.maxTokens === undefined ? "" : formatCapacity(model.maxTokens),
                              readOnly: true,
                              placeholder: AUTO_VALUE_HINT,
                              title: AUTO_VALUE_HINT,
                              "aria-label": `最大输出 token 数 ${position}`,
                            }),
                          ),
                          Checkbox === undefined
                            ? null
                            : h(
                                "fieldset",
                                { className: cls("modelInputTypes"), "aria-label": `输入类型 ${position}` },
                                h("legend", { className: cls("modelFieldLabel") }, "输入类型"),
                                h(
                                  "div",
                                  { className: cls("modelInputChoices") },
                                  ["text", "image"].map((modality) =>
                                    h(Checkbox, {
                                      key: modality,
                                      label: modality === "text" ? "文本" : "图片",
                                      checked: modalities.includes(modality),
                                      disabled: true,
                                      onChange: () => {},
                                    }),
                                  ),
                                ),
                              ),
                        )
                      : null,
                  );
                }),
                error.length > 0 ? h("p", { key: "__error", className: cls("error") }, error) : null,
              ),
              listTarget,
            ),
        modalNode,
        toastNode,
        toastFallbackNode,
      );
    }

    const VENDOR_OTHER = "其他";
    const FILTERS = [
      { id: "all", label: "全部" },
      { id: "unadded", label: "未添加" },
      { id: "added", label: "已添加" },
    ];
    const CARD_LIMIT = 200;

    const ui = {
      border: "1px solid var(--dsw-alias-border-l1, #d0d7de)",
      muted: "var(--dsw-alias-label-secondary, #57606a)",
      dim: "var(--dsw-alias-label-tertiary, #8c959f)",
      danger: "var(--dsw-alias-state-error-primary, #cf222e)",
      warning: "var(--dsw-alias-state-warn-label, #9a6700)",
      blue: "var(--dsw-alias-state-business-primary, #0969da)",
      radius: "10px",
      panel: "var(--dsw-alias-bg-layer-2, #ffffff)",
      subtle: "var(--dsw-alias-bg-module-platform, #f6f8fa)",
      hover: "var(--dsw-alias-interactive-bg-hover, #f3f4f6)",
    };

    function vendorGroups(items) {
      const groups = new Map();
      for (const item of items) {
        const id = typeof item.vendorId === "string" && item.vendorId.length > 0 ? item.vendorId : "other";
        const name = typeof item.vendor === "string" && item.vendor.length > 0 ? item.vendor : VENDOR_OTHER;
        let group = groups.get(id);
        if (group === undefined) {
          group = { id, name, items: [] };
          groups.set(id, group);
        }
        group.items.push(item);
      }
      return [...groups.values()].sort((left, right) => {
        if (left.id === "other" && right.id !== "other") return 1;
        if (right.id === "other" && left.id !== "other") return -1;
        return left.name.localeCompare(right.name, "zh-Hans-CN");
      });
    }

    function emptySelections(results) {
      const selections = {};
      for (const result of results ?? []) selections[result.provider] = new Set();
      return selections;
    }

    function cardStyle(expanded) {
      return {
        border: ui.border,
        borderRadius: ui.radius,
        background: ui.panel,
        overflow: "hidden",
        minWidth: 0,
      };
    }

    function FilterButton({ active, onClick, children }) {
      return h(
        "button",
        {
          type: "button",
          onClick,
          "aria-pressed": active,
          style: {
            border: active ? `1px solid ${ui.blue}` : ui.border,
            background: active ? ui.blue : "transparent",
            color: active ? "#fff" : ui.muted,
            borderRadius: "999px",
            padding: "3px 9px",
            fontSize: "12px",
            lineHeight: "18px",
            cursor: "pointer",
          },
        },
        children,
      );
    }

    function GroupCheckbox({ label, items, checked, onChange, disabled = false }) {
      const ref = useRef(null);
      const selected = items.reduce((total, item) => total + (checked.has(item.id) ? 1 : 0), 0);
      const all = items.length > 0 && selected === items.length;
      const partial = selected > 0 && !all;
      useEffect(() => {
        if (ref.current !== null) ref.current.indeterminate = partial;
      }, [partial]);
      return h("input", {
        ref,
        type: "checkbox",
        checked: all,
        disabled: disabled || items.length === 0,
        "aria-label": `选择 ${label}`,
        onChange: () => onChange(!all),
        style: { flex: "none", margin: "2px 0 0" },
      });
    }

    function ProviderCard(props) {
      const {
        result,
        expanded,
        onToggle,
        checked,
        removals,
        toggle,
        toggleRemoval,
        setMany,
        onClear,
        query,
        onQuery,
        filter,
        onFilter,
        showAll,
        onShowAll,
        managed,
        onManagedChange,
        busy,
        lastApply,
        updatedAt,
        sinceAt,
      } = props;
      const newItems = Array.isArray(result.newItems) ? result.newItems : [];
      const removed = Array.isArray(result.removed) ? result.removed : [];
      const repairs = Array.isArray(result.repairs) ? result.repairs : [];
      const allItems = Array.isArray(result.allItems)
        ? result.allItems
        : newItems.map((item) => ({ ...item, added: false, status: "available" }));
      const visibleItems = allItems.filter((item) => item.status !== "skipped");
      const availableItems = visibleItems.filter((item) => item.status === "available");
      const addedItems = visibleItems.filter((item) => item.status === "added");
      const skippedItems = allItems.filter((item) => item.status === "skipped");
      const selected = availableItems.reduce((total, item) => total + (checked.has(item.id) ? 1 : 0), 0);
      const pendingRemovals = addedItems.reduce((total, item) => total + (removals.has(item.id) ? 1 : 0), 0);
      const normalizedQuery = query.trim().toLowerCase();
      const filtered = visibleItems.filter((item) => {
        if (normalizedQuery.length > 0 && !`${item.id} ${item.name ?? ""}`.toLowerCase().includes(normalizedQuery)) return false;
        if (filter === "added") return item.status === "added";
        if (filter === "unadded") return item.status !== "added";
        return true;
      });
      const visible = showAll ? filtered : filtered.slice(0, CARD_LIMIT);
      const groups = vendorGroups(visible);
      const credentialWarning = result.credential && (result.credential.readOnly === true || result.credential.shadowed === true);
      const applied = (lastApply?.applied ?? []).find((entry) => entry.provider === result.provider);
      const warning = result.status === "discovery-failed" || credentialWarning;
      const statusText = result.status === "discovery-failed"
        ? "检查失败"
        : result.status === "unmanaged"
          ? "未参与检查"
          : availableItems.length > 0
            ? `${availableItems.length} 个可添加`
            : "已是最新";

      return h(
        "div",
        { style: cardStyle(expanded) },
        h(
          "button",
          {
            type: "button",
            onClick: onToggle,
            "aria-expanded": expanded,
            style: {
              display: "flex",
              alignItems: "center",
              gap: "10px",
              width: "100%",
              border: "none",
              background: "transparent",
              color: "inherit",
              textAlign: "left",
              padding: "12px 14px",
              font: "inherit",
              cursor: "pointer",
            },
          },
          h("strong", { style: { minWidth: 0, fontSize: "14px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label(result.provider)),
          h("span", { style: { color: result.status === "discovery-failed" ? ui.danger : ui.muted, fontSize: "12px", whiteSpace: "nowrap" } }, statusText),
          typeof updatedAt === "number" && updatedAt > sinceAt
            ? h("span", { title: formatTime(updatedAt), style: { color: ui.blue, background: "color-mix(in srgb, currentColor 12%, transparent)", borderRadius: "999px", padding: "2px 7px", fontSize: "11px", lineHeight: "16px", whiteSpace: "nowrap" } }, `有更新 · ${formatUpdateTime(updatedAt)}`)
            : null,
          availableItems.length > 0
            ? h("span", { style: { color: ui.muted, fontSize: "12px", whiteSpace: "nowrap" } }, `已选 ${selected}`)
            : null,
          addedItems.length > 0
            ? h("span", { style: { color: ui.dim, fontSize: "12px", whiteSpace: "nowrap" } }, `已添加 ${addedItems.length}`)
            : null,
          pendingRemovals > 0
            ? h("span", { style: { color: ui.warning, fontSize: "12px", whiteSpace: "nowrap" } }, `待移除 ${pendingRemovals}`)
            : null,
          warning ? h("span", { title: credentialWarning ? "凭证为只读，详情见维护与诊断" : "检查失败，详情见维护与诊断", style: { marginLeft: "auto", color: ui.warning } }, "⚠") : null,
          h("span", { style: { marginLeft: warning ? "0" : "auto", display: "inline-flex", color: ui.dim } }, expanded ? h(ChevronDownIcon, { size: 14 }) : h(ChevronRightIcon, { size: 14 })),
        ),
        expanded
          ? h(
              "div",
              { style: { borderTop: "1px solid var(--dsw-alias-border-l1, #d0d7de)", padding: "10px 14px 14px" } },
              visibleItems.length > 0
                ? h(
                    "div",
                    null,
                    h(
                      "div",
                      { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", margin: "2px 0 8px" } },
                      h("input", {
                        type: "text",
                        value: query,
                        placeholder: "搜索模型 id / 名称",
                        onChange: (event) => onQuery(event.target.value),
                        style: { flex: "1 1 220px", minWidth: "160px", height: "30px", padding: "0 9px", borderRadius: "7px", border: ui.border, background: "transparent", color: "inherit", fontSize: "13px" },
                      }),
                      h(
                        "div",
                        { style: { display: "flex", gap: "5px" } },
                        FILTERS.map((entry) => h(FilterButton, { key: entry.id, active: filter === entry.id, onClick: () => onFilter(entry.id) }, entry.label)),
                      ),
                      h(
                        "button",
                        { type: "button", disabled: busy === true || filtered.every((item) => item.status !== "available"), onClick: () => setMany(result.provider, filtered.filter((item) => item.status === "available").map((item) => item.id), true), style: { border: "none", background: "none", padding: 0, color: ui.blue, fontSize: "12px", cursor: "pointer" } },
                        "全选",
                      ),
                      h(
                        "button",
                        { type: "button", disabled: busy === true || (availableItems.every((item) => !checked.has(item.id)) && addedItems.every((item) => !removals.has(item.id))), onClick: onClear, style: { border: "none", background: "none", padding: 0, color: ui.dim, fontSize: "12px", cursor: "pointer" } },
                        "清空",
                      ),
                    ),
                    groups.length > 0
                      ? h(
                          "div",
                          { style: { columnWidth: "240px", columnGap: "10px" } },
                          groups.map((group) => {
                            const groupAvailable = group.items.filter((item) => item.status === "available");
                            const groupAdded = group.items.filter((item) => item.status === "added");
                            const groupSelected = groupAvailable.reduce((total, item) => total + (checked.has(item.id) ? 1 : 0), 0);
                            return h(
                              "section",
                              { key: group.id, style: { minWidth: 0, border: ui.border, borderRadius: "8px", padding: "8px 10px", background: ui.subtle, breakInside: "avoid", pageBreakInside: "avoid", marginBottom: "10px" } },
                              h(
                                "div",
                                { style: { display: "flex", alignItems: "flex-start", gap: "7px", paddingBottom: "4px" } },
                                h(GroupCheckbox, {
                                  label: `${group.name} 未添加模型`,
                                  items: groupAvailable,
                                  checked,
                                  disabled: busy === true,
                                  onChange: (value) => setMany(result.provider, groupAvailable.map((item) => item.id), value),
                                }),
                                h("strong", { style: { flex: "1", minWidth: 0, fontSize: "13px", lineHeight: "18px" } }, group.name),
                                groupAvailable.length > 0
                                  ? h("span", { style: { color: ui.dim, fontSize: "11px", whiteSpace: "nowrap" } }, `可选 ${groupSelected}/${groupAvailable.length}`)
                                  : null,
                                groupAdded.length > 0
                                  ? h("span", { style: { color: ui.dim, fontSize: "11px", whiteSpace: "nowrap" } }, `已添加 ${groupAdded.length}`)
                                  : null,
                              ),
                              h(
                                "div",
                                null,
                                group.items.map((item) => {
                                  const added = item.status === "added";
                                  const skipped = item.status === "skipped";
                                  const removable = added && typeof item.target === "string";
                                  const pendingRemoval = added && removals.has(item.id);
                                  const rowChecked = added ? !pendingRemoval : checked.has(item.id);
                                  const disabled = busy === true || skipped || (added && !removable);
                                  const reason = skipped ? item.reason : added && !removable ? "由用户管理，不能在插件里移除" : undefined;
                                  return h(
                                    "label",
                                    { key: item.id, title: reason, style: { display: "flex", alignItems: "flex-start", gap: "7px", padding: "3px 0", fontSize: "13px", lineHeight: "18px", cursor: disabled ? "default" : "pointer" } },
                                    h("input", {
                                      type: "checkbox",
                                      checked: rowChecked,
                                      disabled,
                                      onChange: () => {
                                        if (added) {
                                          if (removable) toggleRemoval(result.provider, item.id);
                                        } else if (!skipped) {
                                          toggle(result.provider, item.id);
                                        }
                                      },
                                      style: { flex: "none", margin: "2px 0 0" },
                                    }),
                                    h("span", { style: { minWidth: 0, overflowWrap: "anywhere" } }, modelName(item)),
                                    pendingRemoval ? h("span", { style: { color: ui.warning, fontSize: "11px", whiteSpace: "nowrap" } }, "待移除") : null,
                                    added && !pendingRemoval ? h("span", { style: { color: ui.dim, fontSize: "11px", whiteSpace: "nowrap" } }, "已添加") : null,
                                    skipped ? h("span", { style: { color: ui.warning, fontSize: "11px" } }, "无法添加") : null,
                                  );
                                }),
                              ),
                            );
                          }),
                        )
                      : h("p", { style: { color: ui.dim, fontSize: "12px", margin: "8px 0" } }, filtered.length === 0 ? "没有匹配的模型" : "暂无模型"),
                    filtered.length > visible.length
                      ? h(
                          "div",
                          { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "8px", color: ui.muted, fontSize: "12px" } },
                          h("span", null, `当前筛选共 ${filtered.length} 个，已显示前 ${visible.length} 个`),
                          h("button", { type: "button", onClick: onShowAll, style: { border: "none", background: "none", padding: 0, color: ui.blue, fontSize: "12px", cursor: "pointer" } }, "显示全部"),
                        )
                      : null,
                  )
                : null,
              h(
                "details",
                { style: { marginTop: "12px" } },
                h("summary", { style: { color: ui.dim, fontSize: "12px", cursor: "pointer" } }, "维护与诊断"),
                h(
                  "div",
                  { style: { marginTop: "8px", color: ui.muted, fontSize: "12px", lineHeight: "1.6" } },
                  h(
                    "label",
                    { style: { display: "flex", alignItems: "center", gap: "7px", cursor: "pointer", color: ui.muted } },
                    h("input", {
                      type: "checkbox",
                      checked: managed,
                      disabled: busy === true,
                      onChange: (event) => onManagedChange(result.provider, event.target.checked),
                    }),
                    "参与检查此服务商",
                  ),
                  credentialWarning
                    ? h("div", { style: { marginTop: "6px", color: ui.warning } }, `⚠️ ${result.credential.warning ?? `凭证 ${result.credential.ref} 为只读`}`)
                    : null,
                  result.status === "discovery-failed"
                    ? h("div", { style: { marginTop: "6px", color: ui.danger } }, `检查失败：${result.error}`)
                    : null,
                  removed.length > 0
                    ? h(
                        "div",
                        { style: { marginTop: "6px" } },
                        h("strong", { style: { color: ui.muted } }, "最近一次检查已下架（仅提示，不删除）"),
                        h("div", null, removed.map((entry) => entry.id).join(", ")),
                      )
                    : null,
                  skippedItems.length > 0
                    ? h(
                        "div",
                        { style: { marginTop: "6px" } },
                        h("strong", { style: { color: ui.warning } }, "无法添加"),
                        h("div", null, skippedItems.map((entry) => `${entry.id}（${entry.reason}）`).join("；")),
                      )
                    : null,
                  repairs.length > 0
                    ? h("div", { style: { marginTop: "6px" } }, `协议修正 ${repairs.length} 个（添加模型时自动应用）`)
                    : null,
                  applied !== undefined
                    ? h("div", { style: { marginTop: "6px" } }, `上次添加：${applied.added ?? 0} 个模型 · ${formatTime(lastApply?.at)}`)
                    : null,
                  h(
                    "details",
                    { style: { marginTop: "6px" } },
                    h("summary", { style: { color: ui.dim, cursor: "pointer" } }, "技术详情"),
                    h(
                      "div",
                      { style: { marginTop: "4px" } },
                      result.discoveryBase ? h("div", null, `上游：${result.discoveryBase}`) : null,
                      typeof result.discovered === "number" ? h("div", null, `上游模型总数：${result.discovered}`) : null,
                      availableItems.length > 0
                        ? h("div", null, `放置：${availableItems.map((item) => `${item.id} → ${label(item.target)}（${item.api}）`).join("；")}`)
                        : null,
                    ),
                  ),
                ),
              ),
            )
          : null,
      );
    }
    function Section({ title, count, children }) {
      return h(
        "section",
        { style: { marginTop: "16px" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: "7px", marginBottom: "8px" } },
          h("h3", { style: { margin: 0, fontSize: "14px" } }, title),
          count !== undefined ? h("span", { style: { color: ui.dim, fontSize: "12px" } }, String(count)) : null,
        ),
        h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } }, children),
      );
    }

    function Panel() {
      const [state, setState] = useState(undefined);
      const [checked, setChecked] = useState({});
      const [removals, setRemovals] = useState({});
      const [queries, setQueries] = useState({});
      const [filters, setFilters] = useState({});
      const [showAll, setShowAll] = useState({});
      const [expanded, setExpanded] = useState(null);
      const [sinceAt, setSinceAt] = useState(0);
      const openedRef = useRef(false);
      const [busy, setBusy] = useState("");
      const [syncing, setSyncing] = useState(false);
      const [toast, setToast] = useState(null);
      const [error, setError] = useState("");
      const [message, setMessage] = useState("");
      const lastInitializedAt = useRef(null);

      const showToast = useCallback((text) => {
        if (Toast === undefined) setMessage(text);
        else setToast({ text, seq: Date.now() });
      }, []);

      const refresh = useCallback(async () => {
        const next = await api("/state");
        setState(next);
        setError("");
        return next;
      }, []);

      const check = useCallback(async () => {
        setBusy("check");
        setError("");
        setMessage("");
        try {
          const payload = await api("/check", { method: "POST" });
          const next = await refresh();
          lastInitializedAt.current = next?.lastCheck?.at ?? null;
          setChecked(emptySelections(payload.results));
          setRemovals({});
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy("");
        }
      }, [refresh]);

      useEffect(() => {
        void refresh().catch((err) => setError(err.message));
      }, [refresh]);

      useEffect(() => {
        if (openedRef.current || state === undefined) return;
        openedRef.current = true;
        setSinceAt(state.lastOpenedAt ?? 0);
        void api("/opened", { method: "POST" }).catch(() => {});
      }, [state]);

      useEffect(() => {
        if (lastInitializedAt.current !== null) return;
        const at = state?.lastCheck?.at;
        if (at === undefined || at === null) return;
        lastInitializedAt.current = at;
        setChecked(emptySelections(state.lastCheck.results));
      }, [state?.lastCheck?.at, state?.selectionHabits]);

      const toggle = useCallback((provider, id) => {
        setChecked((current) => {
          const next = { ...current };
          const set = new Set(next[provider] ?? []);
          if (set.has(id)) set.delete(id);
          else set.add(id);
          next[provider] = set;
          return next;
        });
      }, []);

      const toggleRemoval = useCallback((provider, id) => {
        setRemovals((current) => {
          const next = { ...current };
          const set = new Set(next[provider] ?? []);
          if (set.has(id)) set.delete(id);
          else set.add(id);
          next[provider] = set;
          return next;
        });
      }, []);

      const setMany = useCallback((provider, ids, value) => {
        setChecked((current) => {
          const next = { ...current };
          const set = new Set(next[provider] ?? []);
          for (const id of ids) {
            if (value) set.add(id);
            else set.delete(id);
          }
          next[provider] = set;
          return next;
        });
      }, []);

      const clearProvider = useCallback((provider) => {
        setChecked((current) => {
          const next = { ...current };
          next[provider] = new Set();
          return next;
        });
        setRemovals((current) => {
          const next = { ...current };
          next[provider] = new Set();
          return next;
        });
      }, []);

      const setQuery = useCallback((provider, value) => {
        setQueries((current) => ({ ...current, [provider]: value }));
      }, []);

      const setFilter = useCallback((provider, value) => {
        setFilters((current) => ({ ...current, [provider]: value }));
      }, []);

      const setAll = useCallback((provider, value) => {
        setShowAll((current) => ({ ...current, [provider]: value }));
      }, []);

      const changeManaged = useCallback(
        async (provider, managed) => {
          setBusy(`managed:${provider}`);
          setError("");
          try {
            await api("/settings", { method: "POST", body: JSON.stringify({ provider, managed }) });
            if (managed) await check();
            else await refresh();
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy("");
          }
        },
        [check, refresh],
      );

      const apply = useCallback(async () => {
        const selections = {};
        for (const [provider, set] of Object.entries(checked)) {
          if (set.size > 0) selections[provider] = [...set];
        }
        const targetByProviderModel = new Map();
        for (const result of state?.lastCheck?.results ?? []) {
          for (const item of result.allItems ?? []) {
            if (typeof item?.id === 'string' && typeof item.target === 'string') {
              targetByProviderModel.set(`${result.provider}\u0000${item.id}`, item.target);
            }
          }
        }
        const removalItems = [];
        for (const [provider, set] of Object.entries(removals)) {
          for (const modelId of set) {
            const target = targetByProviderModel.get(`${provider}\u0000${modelId}`) ?? provider;
            removalItems.push({ provider: target, modelId });
          }
        }
        if (Object.keys(selections).length === 0 && removalItems.length === 0) return;
        setBusy("apply");
        setError("");
        setMessage("");
        let added = 0;
        let removed = 0;
        try {
          if (removalItems.length > 0) {
            const outcome = await api("/remove-managed", { method: "POST", body: JSON.stringify({ removals: removalItems, recheck: false }) });
            removed = outcome.removed ?? 0;
          }
          if (Object.keys(selections).length > 0) {
            const outcome = await api("/apply", { method: "POST", body: JSON.stringify({ selections, repairs: true, recheck: false }) });
            added = (outcome.applied ?? []).reduce((total, entry) => total + (entry.added ?? 0), 0);
            if ((outcome.errors ?? []).length > 0) setError(outcome.errors.join("; "));
          }
          const parts = [];
          if (added > 0) parts.push(`已添加 ${added} 个模型`);
          if (removed > 0) parts.push(`已移除 ${removed} 个模型`);
          if (parts.length > 0) showToast(parts.join("，"));
          setSyncing(true);
          void (async () => {
            try {
              await api("/check", { method: "POST" });
              await refresh();
              setChecked({});
              setRemovals({});
            } catch (err) {
              setError(`模型已保存，但同步最新状态失败：${err.message}`);
            } finally {
              setSyncing(false);
            }
          })();
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy("");
        }
      }, [checked, removals, refresh, showToast, state?.lastCheck?.results]);

      const results = useMemo(() => state?.lastCheck?.results ?? [], [state]);
      const pendingResults = useMemo(() => results.filter((result) => result.status === "ok" && (result.newItems ?? []).length > 0), [results]);
      const totalAvailable = useMemo(() => results.reduce((total, result) => total + (result.newItems?.length ?? 0), 0), [results]);
      const totalAdd = useMemo(() => Object.values(checked).reduce((total, set) => total + set.size, 0), [checked]);
      const totalRemove = useMemo(() => Object.values(removals).reduce((total, set) => total + set.size, 0), [removals]);
      const busyOrSyncing = busy !== "" || syncing;

      const cardFor = (result) =>
        h(ProviderCard, {
          key: result.provider,
          result,
          expanded: expanded === result.provider,
          onToggle: () => setExpanded((current) => (current === result.provider ? null : result.provider)),
          checked: checked[result.provider] ?? new Set(),
          removals: removals[result.provider] ?? new Set(),
          toggle,
          toggleRemoval,
          setMany,
          onClear: () => clearProvider(result.provider),
          query: queries[result.provider] ?? "",
          onQuery: (value) => setQuery(result.provider, value),
          filter: filters[result.provider] ?? "all",
          onFilter: (value) => setFilter(result.provider, value),
          showAll: showAll[result.provider] === true,
          onShowAll: () => setAll(result.provider, true),
          managed: state?.managed?.[result.provider] === true,
          onManagedChange: changeManaged,
          busy: busyOrSyncing,
          lastApply: state?.lastApply,
          updatedAt: state?.providerUpdates?.[result.provider] ?? 0,
          sinceAt,
        });

      const summary = state === undefined
        ? "加载中…"
        : state.lastCheck?.at === undefined || state.lastCheck?.at === null
          ? "尚未检查"
          : `上次检查 ${formatTime(state.lastCheck.at)} · ${pendingResults.length} 个服务商有更新 · ${totalAvailable} 个可添加${syncing ? " · 同步中…" : ""}`;
      const canApply = (totalAdd > 0 || totalRemove > 0) && !busyOrSyncing;

      return h(
        React.Fragment,
        null,
        h(
          "div",
          { style: { padding: "4px 2px" } },
          h("h2", { style: { margin: "0 0 3px" } }, "模型更新"),
          h("p", { style: { margin: "0 0 10px", color: ui.muted, fontSize: "13px" } }, "检查上游新模型；只添加你勾选的模型，不删除或改写已有条目。"),
          h(
            "div",
            { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", marginBottom: "6px" } },
            h("div", { style: { color: ui.muted, fontSize: "12px", lineHeight: "20px" } }, summary),
            h(
              "div",
              { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
              h(
                "button",
                {
                  type: "button",
                  onClick: check,
                  disabled: busyOrSyncing,
                  style: { border: ui.border, borderRadius: "7px", padding: "6px 12px", background: "transparent", color: "inherit", font: "inherit", fontSize: "13px", cursor: "pointer" },
                },
                busy === "check" ? "检查中…" : "检查更新",
              ),
            ),
          ),
          message ? h("p", { style: { color: "var(--dsw-alias-state-success-primary, #1a7f37)", fontSize: "13px", margin: "6px 0" } }, message) : null,
          error ? h("p", { style: { color: ui.danger, fontSize: "13px", margin: "6px 0" } }, error) : null,
          results.length === 0
            ? h("p", { style: { color: ui.muted } }, "尚未检查过。点「检查更新」开始。")
            : h(
                React.Fragment,
                null,
                h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } }, results.map(cardFor)),
                h(
                  "div",
                  { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginTop: "16px", paddingTop: "12px", borderTop: `1px solid ${ui.border}` } },
                  h(
                    "span",
                    { style: { color: ui.muted, fontSize: "12px" } },
                    totalAdd > 0 || totalRemove > 0
                      ? `待保存：添加 ${totalAdd} 个 · 移除 ${totalRemove} 个`
                      : "没有待保存的变更",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      onClick: apply,
                      disabled: !canApply,
                      style: { border: "none", borderRadius: "7px", padding: "7px 14px", background: canApply ? ui.blue : ui.subtle, color: canApply ? "#fff" : ui.dim, font: "inherit", fontSize: "13px", cursor: canApply ? "pointer" : "default" },
                    },
                    busy === "apply" ? "保存中…" : "保存全部变更",
                  ),
                ),
              ),
        ),
        Toast === undefined || toast === null
          ? null
          : h(Toast, {
              key: toast.seq,
              text: toast.text,
              holdMs: 5000,
              onDone: () => setToast((current) => (current !== null && current.seq === toast.seq ? null : current)),
            }),
      );
    }
    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "model-sync",
            order: 30,
            label: () => "模型更新",
          },
          Panel,
        ),
      );
      ctx.slots.inject("settings.models.provider-card", () =>
        ctx.slots.register(
          {
            name: "settings.models.provider-card",
            key: "llm-pi-ai",
          },
          ManagedPanel,
        ),
      );
      const disposeHider = installSiblingCardHider();
      if (typeof ctx.effect === "function") ctx.effect(() => disposeHider, "dsh-model-sync: sibling card hider");
      installModelGroupMerge(ctx);
    }

    const inject = ["slots"];

    module.exports = {
      apply,
      inject,
      __test: { mergeModelGroups, transformDirectorySnapshot, resolveModelSelection, createMergedDirectory },
    };
    return module.exports;
  },
});
