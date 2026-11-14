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

    // Native model editors identify the root route, while each managed sibling
    // belongs to an opaque settings owner. Never derive that owner from a name.
    function managedSiblingsFor(payload, provider) {
      if (Array.isArray(payload)) return payload.filter((item) => item.routeProvider === provider);
      const route = payload?.routes?.find((item) => item.provider === provider);
      return Array.isArray(route?.siblings) ? route.siblings : [];
    }

    function managedRowKey(item) {
      return JSON.stringify([item.owner ?? null, item.provider, item.modelId ?? item.id]);
    }

    function managedRemovalIssue(item) {
      if (!item || typeof item.owner !== "string" || !item.owner ||
          !Number.isSafeInteger(item.settingsRevision) || item.settingsRevision < 0) {
        return "缺少供应商归属或配置版本，请先在模型更新面板检查目录";
      }
      // /managed only reports ok for a managed, current, successful full catalog.
      if (item.status !== "ok") return item.reason || "目录尚未成功检查或已过期，请先在模型更新面板检查目录";
      return "";
    }

    function managedRemovalEntry(sibling, model) {
      return {
        provider: sibling.provider, owner: sibling.owner, modelId: model.id,
        name: model.name || model.id, settingsRevision: sibling.settingsRevision,
        status: sibling.status,
      };
    }

    function buildManagedRemovalRequest(items, siblings) {
      const expectedRevisions = {};
      const removals = [];
      const blocked = [];
      const submitted = [];
      const seen = new Set();
      for (const item of items) {
        const current = siblings.find((entry) => entry.owner === item.owner && entry.provider === item.provider);
        const reason = managedRemovalIssue(item) || managedRemovalIssue(current) ||
          (current.settingsRevision !== item.settingsRevision ? "配置版本已变化，请取消旧选择并重新检查后确认" : "") ||
          (!current.models?.some((model) => model.id === item.modelId) ? "待移除模型已变化，请取消旧选择并重新检查" : "");
        if (reason) { blocked.push(`${item.name || item.modelId}：${reason}`); continue; }
        if (Object.prototype.hasOwnProperty.call(expectedRevisions, item.owner) && expectedRevisions[item.owner] !== item.settingsRevision) {
          blocked.push(`${item.name || item.modelId}：同一供应商的选择来自不同配置版本，请重新确认`);
          continue;
        }
        // Retain the version captured at selection, never the newer load result.
        Object.defineProperty(expectedRevisions, item.owner, { value: item.settingsRevision, enumerable: true, configurable: true });
        const key = managedRowKey(item);
        if (!seen.has(key)) {
          seen.add(key);
          removals.push({ provider: item.provider, owner: item.owner, id: item.modelId });
        }
        submitted.push(item);
      }
      return { body: { removals, expectedRevisions, repairs: false, recheck: true, rememberHabit: true }, submitted, blocked };
    }

    function clearManagedRemovals(current, submitted, outcome) {
      const failed = new Set((outcome?.errors ?? []).map((entry) => entry.provider));
      const succeeded = new Set((outcome?.applied ?? []).filter((entry) => !failed.has(entry.provider)).map((entry) => entry.provider));
      const exact = new Set(submitted.filter((item) => succeeded.has(item.owner)));
      return current.filter((item) => !exact.has(item));
    }

    function outcomeWarnings(outcome) {
      return (outcome?.warnings ?? []).map((warning) => typeof warning === "string" ? warning
        : warning?.reason || warning?.message || "设置已保存，但后续操作未完成；请刷新后核对，不要重复提交成功项").filter(Boolean);
    }

    const managedRetryHint = "请到“设置 → 模型更新”重新检查目录并重新勾选移除；不要重复点击原生保存";

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
      const payloadRef = useRef(undefined);
      const loadErrorRef = useRef("");
      const committingRef = useRef(false);

      const load = useCallback(async () => {
        const generation = loadGenRef.current + 1;
        loadGenRef.current = generation;
        try {
          const next = await api("/managed");
          if (generation !== loadGenRef.current) return null;
          payloadRef.current = next;
          loadErrorRef.current = "";
          setPayload(next);
          setError("");
          return null;
        } catch (err) {
          if (generation !== loadGenRef.current) return null;
          loadErrorRef.current = err.message;
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
        const items = stagedRef.current.slice();
        if (items.length === 0 || committingRef.current) return;
        const request = buildManagedRemovalRequest(items, managedSiblingsFor(payloadRef.current, providerId));
        const blocked = loadErrorRef.current || request.blocked.join("；");
        if (blocked) {
          pushToast(`尚未提交，已保留移除选择：${blocked}；${managedRetryHint}`);
          return;
        }
        committingRef.current = true;
        try {
          const outcome = await api("/remove", { method: "POST", body: JSON.stringify(request.body) });
          // Only this exact submitted draft may be cleared. Warnings describe
          // post-commit work, so a committed owner must not be replayed for them.
          applyStaged(clearManagedRemovals(stagedRef.current, request.submitted, outcome));
          const applied = outcome.applied ?? [];
          const errors = outcome.errors ?? [];
          const removed = applied.reduce((sum, entry) => sum + (entry.removed ?? 0), 0);
          const unresolved = clearManagedRemovals(request.submitted, request.submitted, outcome).length;
          const messages = [`已移除 ${removed} 个模型`];
          if (errors.length) messages.push(errors.map((entry) => entry.reason || "部分移除失败").join("；"));
          if (unresolved) messages.push(`${unresolved} 项未确认成功，已保留选择；${managedRetryHint}`);
          messages.push(...outcomeWarnings(outcome));
          const failure = await load();
          if (failure !== null) messages.push(`列表刷新失败：${failure}`);
          pushToast(messages.join("；"));
          if (applied.length) window.dispatchEvent(new Event("dsh-model-sync:updated"));
        } catch (err) {
          pushToast(`移除结果未成功确认，已保留 ${items.length} 项选择：${err.message}；${managedRetryHint}`);
        } finally {
          committingRef.current = false;
        }
      }, [providerId, applyStaged, load, pushToast]);

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
      const siblings = managedSiblingsFor(payload, providerId);
      const allRows = siblings.flatMap((sibling) => (sibling.models ?? []).map((model) => ({ sibling, model })));
      const stagedKeys = new Set(staged.map(managedRowKey));
      const rows = allRows.filter(({ sibling, model }) => !stagedKeys.has(managedRowKey({ ...sibling, modelId: model.id })));
      const unavailable = [...new Set(siblings.map(managedRemovalIssue).filter(Boolean))];
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

      const stageRemoval = (entry) => {
        const request = buildManagedRemovalRequest([entry], managedSiblingsFor(payloadRef.current, providerId));
        const issue = loadErrorRef.current || request.blocked.join("；");
        if (issue) { pushToast(`无法选择移除：${issue}`); return; }
        if (stagedRef.current.some((item) => managedRowKey(item) === managedRowKey(entry))) return;
        applyStaged([...stagedRef.current, entry]);
      };

      const openConfirm = (sibling, model) => {
        const issue = loadErrorRef.current || managedRemovalIssue(sibling);
        if (issue) { pushToast(`无法选择移除：${issue}`); return; }
        const entry = managedRemovalEntry(sibling, model);
        if (Modal === undefined || Button === undefined) {
          if (!window.confirm(`移除「${entry.name}」？移除后它不再出现在 DSH 的模型选择中；之后可在「设置 → 模型更新」重新添加。`)) return;
          stageRemoval(entry);
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
                              stageRemoval(entry);
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
                  const key = managedRowKey({ ...sibling, modelId: model.id });
                  const issue = error || managedRemovalIssue(sibling);
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
                          title: issue || "删除模型",
                          disabled: Boolean(issue),
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
                staged.length > 0 ? h("div", { key: "__pending", style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 } },
                  h("span", null, `待移除 ${staged.length} 个模型；保存失败时选择会保留`),
                  h(Button ?? "button", { type: "button", variant: Button === undefined ? undefined : "outline", onClick: discardStaged }, "取消待移除"),
                ) : null,
                error || unavailable.length ? h("p", { key: "__error", className: cls("error") }, error || unavailable.join("；")) : null,
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

    const modelCollator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
    function compareModels(left, right) {
      const byName = modelCollator.compare(modelName(left), modelName(right));
      return byName !== 0 ? byName : modelCollator.compare(left.id, right.id);
    }
    function skippedBreakdown(items) {
      const labels = { "non-chat": "非对话模型", duplicate: "重复日期快照", protocol: "协议未知", other: "其他" };
      const counts = new Map();
      for (const item of items) {
        const key = typeof item.reasonCode === "string" ? item.reasonCode : "other";
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()].map(([key, count]) => `${labels[key] ?? key} ${count}`).join(" · ");
    }

    // Provider ids are opaque configuration-instance ids, never model vendor names.
    function providerName(result) {
      return result.displayName || result.provider;
    }

    function editableResult(result) {
      return result?.status === "ok" && result.stale !== true && Number.isSafeInteger(result.settingsRevision);
    }

    function catalogSummary(catalog) {
      if (!catalog) return "尚无完整目录";
      if (catalog.firstDiscovery) return `首次发现${catalog.total}个 · 已建立目录基线`;
      return `目录${catalog.total}个 · 变化${catalog.changedCount}项（新增${catalog.addedCount} / 移除${catalog.removedCount}）`;
    }

    function captureExpansion(result) {
      const catalog = result.catalog;
      return {
        provider: result.provider,
        revision: result.status === "ok" && result.stale !== true ? catalog?.revision : undefined,
        // Keep the opening snapshot even when a receipt clears the live counters.
        addedIds: result.status === "ok" && !result.stale && !catalog?.firstDiscovery ? [...(catalog?.addedIds ?? [])] : [],
        removedIds: [...(catalog?.removedIds ?? [])],
      };
    }

    function canAcknowledgeCatalog(result, expansion, query, filter, renderedCount) {
      const catalog = result.catalog;
      if (!expansion || result.status !== "ok" || result.stale === true || !catalog) return false;
      if (expansion.provider !== result.provider || typeof expansion.revision !== "string" || expansion.revision !== catalog.revision) return false;
      if (query.trim() || filter !== "all" || !Array.isArray(result.allItems)) return false;
      if (!Number.isSafeInteger(catalog.total) || catalog.total < 0 || result.allItems.length !== catalog.total) return false;
      const ids = result.allItems.map((item) => item.id);
      return ids.every((id) => typeof id === "string") && new Set(ids).size === catalog.total && renderedCount === catalog.total;
    }

    function mergeViewedCatalog(state, provider, revision, receipt) {
      // An R receipt must not overwrite a newer R+1 result (or clear its unread delta).
      if (!receipt?.acknowledged || receipt.catalog?.revision !== revision || !state?.lastCheck) return state;
      const results = state.lastCheck.results ?? [];
      const result = results.find((entry) => entry.provider === provider);
      if (result?.catalog?.revision !== revision || result.status !== "ok" || result.stale) return state;
      return {
        ...state,
        lastCheck: { ...state.lastCheck, results: results.map((entry) => entry === result ? { ...entry, catalog: receipt.catalog } : entry) },
      };
    }

    function updateDraft(drafts, result, ids, enabled, kind = "checked") {
      if (!editableResult(result)) return drafts;
      const old = drafts[result.provider];
      // Do not mix a new displayed settings version into an existing selection.
      if (old && old.settingsRevision !== result.settingsRevision) return drafts;
      const draft = {
        settingsRevision: old?.settingsRevision ?? result.settingsRevision,
        checked: new Set(old?.checked ?? []),
        removals: new Set(old?.removals ?? []),
      };
      const items = result.allItems ?? [];
      for (const id of ids) {
        const item = items.find((entry) => entry.id === id);
        const allowed = kind === "removals"
          ? item?.status === "added" && item.removable === true && item.target === result.provider
          : item?.status === "available";
        if (!allowed) continue;
        if (enabled) draft[kind].add(id);
        else draft[kind].delete(id);
      }
      const next = { ...drafts };
      if (draft.checked.size || draft.removals.size) next[result.provider] = draft;
      else delete next[result.provider];
      return next;
    }

    function buildApplyRequest(drafts, results) {
      const selections = {};
      const removals = [];
      const expectedRevisions = {};
      const submitted = {};
      const blocked = [];
      for (const [provider, draft] of Object.entries(drafts)) {
        if (!draft.checked.size && !draft.removals.size) continue;
        const result = results.find((entry) => entry.provider === provider);
        if (!editableResult(result) || !Number.isSafeInteger(draft.settingsRevision)) {
          blocked.push({ provider, reason: result?.reason || "此供应商尚未成功检查，已保留选择" });
          continue;
        }
        selections[provider] = [...draft.checked];
        for (const id of draft.removals) removals.push({ provider, id });
        expectedRevisions[provider] = draft.settingsRevision;
        submitted[provider] = draft;
      }
      return { body: { selections, removals, expectedRevisions, repairs: false, recheck: true, rememberHabit: true }, submitted, blocked };
    }

    function clearAppliedDrafts(drafts, submitted, outcome) {
      const next = { ...drafts };
      const errors = outcome.errors ?? [];
      for (const entry of outcome.applied ?? []) {
        if (errors.some((error) => !error.provider || error.provider === entry.provider)) continue;
        // Preserve any edits that were not part of this specific request.
        if (submitted[entry.provider] && drafts[entry.provider] === submitted[entry.provider]) delete next[entry.provider];
      }
      return next;
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
        expansion,
        onViewed,
        viewError,
        draftRevision,
      } = props;
      const newItems = Array.isArray(result.newItems) ? result.newItems : [];
      const removed = Array.isArray(result.removed) ? result.removed : [];
      const repairs = Array.isArray(result.repairs) ? result.repairs : [];
      const allItems = Array.isArray(result.allItems)
        ? result.allItems
        : newItems.map((item) => ({ ...item, added: false, status: "available" }));
      // Unsuitable rows (non-chat endpoints, duplicate dated snapshots,
      // unresolvable protocols) are not shown. Their count and reasons stay in
      // diagnostics, and they are excluded from the unread catalog baseline.
      const skippedItems = Array.isArray(result.skipped) ? result.skipped : allItems.filter((item) => item.status === "skipped");
      const visibleItems = allItems.filter((item) => item.status !== "skipped");
      const availableItems = visibleItems.filter((item) => item.status === "available");
      const addedItems = visibleItems.filter((item) => item.status === "added");
      const selected = availableItems.reduce((total, item) => total + (checked.has(item.id) ? 1 : 0), 0);
      const pendingRemovals = addedItems.reduce((total, item) => total + (removals.has(item.id) ? 1 : 0), 0);
      const protocolChoices = availableItems.filter((item) => item.needsProtocol === true && checked.has(item.id));
      const normalizedQuery = query.trim().toLowerCase();
      const filtered = visibleItems.filter((item) => {
        if (normalizedQuery.length > 0 && !`${item.id} ${item.name ?? ""}`.toLowerCase().includes(normalizedQuery)) return false;
        if (filter === "added") return item.status === "added";
        if (filter === "unadded") return item.status !== "added";
        return true;
      }).sort(compareModels);
      const visible = showAll ? filtered : filtered.slice(0, CARD_LIMIT);
      const groups = vendorGroups(visible);
      const credentialWarning = result.credential && (result.credential.readOnly === true || result.credential.shadowed === true);
      const applied = (lastApply?.applied ?? []).find((entry) => entry.provider === result.provider);
      const writable = editableResult(result);
      const draftConflict = draftRevision !== undefined && draftRevision !== result.settingsRevision;
      const cannotEdit = busy === true || !writable || draftConflict;
      const warning = result.status !== "ok" || result.stale === true || credentialWarning;
      const statusText = result.status === "ok"
        ? result.stale ? "上次成功目录（只读）" : ""
        : ({ "discovery-failed": "检查失败", "unmanaged": "未参与检查", "unsupported": "暂不支持", "needs-check": "待检查" }[result.status] ?? "暂不可用");
      const addedSnapshot = new Set(expanded ? expansion?.addedIds ?? [] : []);
      const directoryChanged = expanded && expansion?.revision !== result.catalog?.revision;
      const receiptRef = useRef(null);
      const fullCatalogRendered = expanded && canAcknowledgeCatalog(result, expansion, query, filter, visible.length);
      useEffect(() => {
        if (!fullCatalogRendered || receiptRef.current === expansion) return;
        receiptRef.current = expansion;
        // Effects run only after the full list has committed. The captured
        // revision, not a later background result, is the only one acknowledged.
        onViewed(result.provider, expansion.revision);
      }, [fullCatalogRendered, expansion, onViewed, result.provider]);

      const renderModelRow = (item) => {
        const added = item.status === "added";
        const skipped = item.status === "skipped";
        const removable = added && item.removable === true && item.target === result.provider;
        const pendingRemoval = added && removals.has(item.id);
        const rowChecked = added ? !pendingRemoval : checked.has(item.id);
        const disabled = cannotEdit || skipped || (added && !removable);
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
          addedSnapshot.has(item.id) ? h("span", { "data-catalog-new": item.id, style: { color: ui.blue, background: "color-mix(in srgb, currentColor 10%, transparent)", borderRadius: "4px", padding: "0 4px", fontSize: "11px", whiteSpace: "nowrap" } }, "新增") : null,
          pendingRemoval ? h("span", { style: { color: ui.warning, fontSize: "11px", whiteSpace: "nowrap" } }, "待移除") : null,
          added && !pendingRemoval ? h("span", { style: { color: ui.dim, fontSize: "11px", whiteSpace: "nowrap" } }, "已添加") : null,
          item.needsProtocol === true ? h("span", { style: { color: ui.warning, fontSize: "11px", whiteSpace: "nowrap" } }, "需写入协议") : null,
        );
      };

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
          h("strong", { style: { minWidth: 0, fontSize: "14px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, providerName(result)),
          h("span", { style: { color: result.catalog?.changedCount > 0 ? ui.blue : ui.muted, fontSize: "12px" } }, `${catalogSummary(result.catalog)}${skippedItems.length > 0 ? ` · 已过滤 ${skippedItems.length}` : ""}`),
          statusText ? h("span", { style: { color: warning ? ui.warning : ui.muted, fontSize: "12px", whiteSpace: "nowrap" } }, statusText) : null,
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
              h("p", { style: { margin: "0 0 8px", color: ui.muted, fontSize: "12px" }, title: skippedBreakdown(skippedItems) }, skippedItems.length > 0
                ? `模型配置：已添加 ${addedItems.length} · 可添加 ${availableItems.length} · 已过滤 ${skippedItems.length} 个不适用模型`
                : `模型配置：已添加 ${addedItems.length} · 可添加 ${availableItems.length}`),
              result.notice ? h("p", { role: "note", style: { margin: "0 0 8px", color: ui.warning, fontSize: "12px" } }, result.notice) : null,
              !writable ? h("p", { role: "status", style: { color: ui.warning, fontSize: "12px" } }, `${statusText || "只读"}：${result.reason || result.error || "请先成功检查此供应商"}。此目录仅供查看，不会标记已读或保存选择。`) : null,
              draftConflict ? h("p", { role: "status", style: { color: ui.warning, fontSize: "12px" } }, "配置版本已改变，原选择已保留；请清空后重新勾选。保存不会覆盖新版配置。") : null,
              protocolChoices.length > 0
                ? h("p", { role: "status", style: { color: ui.warning, fontSize: "12px" } }, `选中的 ${protocolChoices.length} 个模型不在 DSH SDK 目录中；保存会把此供应商的调用协议写为 ${protocolChoices[0].api}，之后该供应商的模型都按此协议调用。`)
                : null,
              directoryChanged ? h("p", { role: "status", style: { color: ui.blue, fontSize: "12px" } }, "目录已在后台更新；收起再展开可查看新一轮变化。本次不会自动标记新目录已读。") : null,
              viewError ? h("p", { role: "status", style: { color: ui.warning, fontSize: "12px" } }, viewError) : null,
              expansion?.removedIds.length > 0
                ? h("div", { style: { color: ui.warning, fontSize: "12px", margin: "8px 0", overflowWrap: "anywhere" } }, `自上次完整查看后移除 ${expansion.removedIds.length} 个：${expansion.removedIds.join("、")}（仅提示，不自动删除配置）`)
                : null,
              visibleItems.length === 0 && result.catalog ? h("p", { style: { color: ui.dim, fontSize: "12px" } }, skippedItems.length > 0 ? `没有可显示的对话模型（已过滤 ${skippedItems.length} 个不适用模型，原因见下方诊断）。` : "完整目录为空。") : null,
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
                        { type: "button", disabled: cannotEdit || filtered.every((item) => item.status !== "available"), onClick: () => setMany(result.provider, filtered.filter((item) => item.status === "available").map((item) => item.id), true), style: { border: "none", background: "none", padding: 0, color: ui.blue, fontSize: "12px", cursor: "pointer" } },
                        "全选",
                      ),
                      h(
                        "button",
                        { type: "button", disabled: busy === true || (availableItems.every((item) => !checked.has(item.id)) && addedItems.every((item) => !removals.has(item.id))), onClick: onClear, style: { border: "none", background: "none", padding: 0, color: ui.dim, fontSize: "12px", cursor: "pointer" } },
                        "清空",
                      ),
                    ),
                    groups.length > 0
                      ? result.layout === "grid"
                        ? h(
                            "div",
                            { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: "18px" } },
                            visible.map(renderModelRow),
                          )
                        : h(
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
                                    disabled: cannotEdit,
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
                                h("div", null, group.items.map(renderModelRow)),
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
                    ? h("div", { style: { marginTop: "6px", color: ui.danger } }, `检查失败：${result.reason || result.error || "未返回完整目录"}`)
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
                        h("strong", { style: { color: ui.warning } }, "已过滤的不适用模型（不参与目录变化统计）"),
                        h("div", null, `${skippedItems.length} 个：${skippedBreakdown(skippedItems)}`),
                      )
                    : null,
                  repairs.length > 0
                    ? h("div", { style: { marginTop: "6px" } }, `协议修正建议 ${repairs.length} 个（本次保存不自动应用）`)
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
                      h("div", null, `配置实例：${result.provider} · 适配器：${result.adapter ?? "未知"}`),
                      result.discoveryBase ? h("div", null, `上游：${result.discoveryBase}`) : null,
                      typeof result.discovered === "number" ? h("div", null, `上游模型总数：${result.discovered}`) : null,
                      availableItems.length > 0
                        ? h("div", null, `放置：${availableItems.map((item) => `${item.id} → ${item.originProviderName || providerName(result)}（${item.api}）`).join("；")}`)
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
      const [drafts, setDrafts] = useState({});
      const [queries, setQueries] = useState({});
      const [filters, setFilters] = useState({});
      const [showAll, setShowAll] = useState({});
      const [expanded, setExpanded] = useState(null);
      const [viewErrors, setViewErrors] = useState({});
      const viewReceipts = useRef(new Map());
      const [busy, setBusy] = useState("");
      const [toast, setToast] = useState(null);
      const [error, setError] = useState("");
      const [message, setMessage] = useState("");

      const showToast = useCallback((text) => {
        if (Toast === undefined) setMessage(text);
        else setToast({ text, seq: Date.now() });
      }, []);

      const refresh = useCallback(async () => {
        let next = await api("/state");
        // A GET already in flight can finish after its view receipt. Preserve
        // confirmed counters for that same revision, never for a later one.
        for (const [provider, receipt] of viewReceipts.current) {
          if (receipt.acknowledged && receipt.catalog) next = mergeViewedCatalog(next, provider, receipt.revision, receipt);
        }
        setState(next);
        return next;
      }, []);

      const check = useCallback(async () => {
        setBusy("check");
        setError("");
        setMessage("");
        try {
          await api("/check", { method: "POST" });
          // Refreshes never discard an unsaved or failed selection.
          await refresh();
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy("");
        }
      }, [refresh]);

      useEffect(() => {
        void refresh().catch((err) => setError(err.message));
      }, [refresh]);

      const viewed = useCallback(async (provider, revision) => {
        // A rapid close/reopen shares the pending receipt. Only confirmed
        // receipts suppress later tags; a failed request remains retryable.
        if (viewReceipts.current.get(provider)?.revision === revision) return;
        const attempt = { revision, acknowledged: false };
        viewReceipts.current.set(provider, attempt);
        const forgetAttempt = () => {
          if (viewReceipts.current.get(provider) === attempt) viewReceipts.current.delete(provider);
        };
        try {
          const receipt = await api("/viewed", { method: "POST", body: JSON.stringify({ provider, revision }) });
          if (receipt.acknowledged) {
            attempt.acknowledged = true;
            attempt.catalog = receipt.catalog;
            setState((current) => mergeViewedCatalog(current, provider, revision, receipt));
            if (!receipt.catalog) await refresh();
            setViewErrors((current) => ({ ...current, [provider]: { revision, message: "" } }));
          } else {
            forgetAttempt();
            setViewErrors((current) => ({ ...current, [provider]: { revision, message: `目录未标记已读：${receipt.reason || "版本已变化，请收起后重新展开"}` } }));
          }
        } catch (err) {
          if (!attempt.acknowledged) forgetAttempt();
          const message = attempt.acknowledged ? `已标记已读，但刷新状态失败：${err.message}` : `未读状态未保存：${err.message}。收起后重新展开可重试。`;
          setViewErrors((current) => ({ ...current, [provider]: { revision, message } }));
        }
      }, [refresh]);

      const clearProvider = useCallback((provider) => {
        setDrafts((current) => {
          const next = { ...current };
          delete next[provider];
          return next;
        });
      }, []);

      const toggleProvider = (result) => {
        if (expanded?.provider === result.provider) {
          setExpanded(null);
          return;
        }
        // Start with every row rendered, even after a previous search or paging.
        // Subsequent filtering is fine: it cannot acknowledge a different revision.
        setQueries((current) => ({ ...current, [result.provider]: "" }));
        setFilters((current) => ({ ...current, [result.provider]: "all" }));
        setShowAll((current) => ({ ...current, [result.provider]: true }));
        setViewErrors((current) => ({ ...current, [result.provider]: null }));
        const opening = captureExpansion(result);
        const receipt = viewReceipts.current.get(result.provider);
        if (receipt?.acknowledged && receipt.revision === opening.revision) opening.addedIds = [];
        setExpanded(opening);
      };

      const setQuery = useCallback((provider, value) => {
        setQueries((current) => ({ ...current, [provider]: value }));
      }, []);

      const setFilter = useCallback((provider, value) => {
        setFilters((current) => ({ ...current, [provider]: value }));
      }, []);

      const setAll = useCallback((provider, value) => {
        setShowAll((current) => ({ ...current, [provider]: value }));
      }, []);

      const changeProxy = useCallback(
        async (enabled) => {
          setBusy("proxy");
          setError("");
          setMessage("");
          try {
            const next = await api("/proxy", { method: "POST", body: JSON.stringify({ enabled }) });
            // Re-check so the catalog reflects the transport that is now live;
            // a failed provider still reports its own reason per card.
            if (enabled) await check();
            else await refresh();
            // Report what the host actually did, not what we asked for: an
            // enabled switch can still be "not installed" (no proxy / dead
            // proxy / missing Harness package) and must not claim success.
            setMessage(
              next && next.active === true
                ? "已开启系统代理：目录检查与对话都会走它"
                : enabled
                  ? "已开启，但当前没有接管到系统代理（原因见上方状态）"
                  : "已关闭系统代理：目录检查与对话恢复直连",
            );
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy("");
          }
        },
        [check, refresh],
      );

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
        const results = state?.lastCheck?.results ?? [];
        const { body, submitted, blocked } = buildApplyRequest(drafts, results);
        const describeErrors = (errors) => errors.map((entry) => {
          const result = results.find((item) => item.provider === entry.provider);
          return `${result ? providerName(result) : entry.provider || "保存失败"}：${entry.reason || String(entry)}`;
        }).join("；");
        if (Object.keys(submitted).length === 0) {
          setError(describeErrors(blocked));
          return;
        }
        setBusy("apply");
        setError("");
        setMessage("");
        try {
          // Additions and removals are one Host transaction with the versions
          // shown when the user selected them; no separate removal request.
          const outcome = await api("/apply", { method: "POST", body: JSON.stringify(body) });
          setDrafts((current) => clearAppliedDrafts(current, submitted, outcome));
          const applied = outcome.applied ?? [];
          const added = applied.reduce((total, entry) => total + (entry.added ?? 0), 0);
          const removed = applied.reduce((total, entry) => total + (entry.removed ?? 0), 0);
          const warnings = outcomeWarnings(outcome);
          const notice = [applied.length > 0 ? `已保存：添加 ${added} 个模型 · 移除 ${removed} 个模型` : "", ...warnings].filter(Boolean).join("；");
          if (notice) showToast(notice);
          if (Toast !== undefined && warnings.length) setMessage(warnings.join("；"));
          const problems = describeErrors([...blocked, ...(outcome.errors ?? [])]);
          setError(problems || (applied.length === 0 ? "未收到成功保存的结果，选择已保留。" : ""));
          try {
            await refresh();
          } catch (err) {
            setError([problems, `保存结果已返回，但读取最新状态失败：${err.message}`].filter(Boolean).join("；"));
          }
        } catch (err) {
          setError(`${err.message}；未确认成功的选择已保留。`);
        } finally {
          setBusy("");
        }
      }, [drafts, refresh, showToast, state?.lastCheck?.results]);

      const results = useMemo(() => state?.lastCheck?.results ?? [], [state]);
      const pendingResults = useMemo(() => results.filter((result) => (result.catalog?.changedCount ?? 0) > 0), [results]);
      const totalChanged = useMemo(() => results.reduce((total, result) => total + (result.catalog?.changedCount ?? 0), 0), [results]);
      const totalAvailable = useMemo(() => results.reduce((total, result) => total + (editableResult(result) ? result.newItems?.length ?? 0 : 0), 0), [results]);
      const totalAdd = useMemo(() => Object.values(drafts).reduce((total, draft) => total + draft.checked.size, 0), [drafts]);
      const totalRemove = useMemo(() => Object.values(drafts).reduce((total, draft) => total + draft.removals.size, 0), [drafts]);
      const busyOrSyncing = busy !== "";

      const cardFor = (result) =>
        h(ProviderCard, {
          key: result.provider,
          result,
          expanded: expanded?.provider === result.provider,
          expansion: expanded?.provider === result.provider ? expanded : null,
          onToggle: () => toggleProvider(result),
          onViewed: viewed,
          viewError: viewErrors[result.provider]?.revision === expanded?.revision ? viewErrors[result.provider]?.message : "",
          draftRevision: drafts[result.provider]?.settingsRevision,
          checked: drafts[result.provider]?.checked ?? new Set(),
          removals: drafts[result.provider]?.removals ?? new Set(),
          toggle: (_provider, id) => setDrafts((current) => updateDraft(current, result, [id], !current[result.provider]?.checked.has(id))),
          toggleRemoval: (_provider, id) => setDrafts((current) => updateDraft(current, result, [id], !current[result.provider]?.removals.has(id), "removals")),
          setMany: (_provider, ids, value) => setDrafts((current) => updateDraft(current, result, ids, value)),
          onClear: () => clearProvider(result.provider),
          query: queries[result.provider] ?? "",
          onQuery: (value) => setQuery(result.provider, value),
          filter: filters[result.provider] ?? "all",
          onFilter: (value) => setFilter(result.provider, value),
          showAll: showAll[result.provider] === true,
          onShowAll: () => setAll(result.provider, true),
          managed: Array.isArray(state?.managed)
            ? state.managed.some((entry) => entry.provider === result.provider && entry.managed === true)
            : (state?.managed ?? state?.status?.managed)?.[result.provider] === true,
          onManagedChange: changeManaged,
          busy: busyOrSyncing,
          lastApply: state?.lastApply,
        });

      const summary = state === undefined
        ? "加载中…"
        : state.lastCheck?.at === undefined || state.lastCheck?.at === null
          ? "尚未检查"
          : `上次检查 ${formatTime(state.lastCheck.at)} · ${pendingResults.length} 个供应商有未读目录变化（${totalChanged} 项） · ${totalAvailable} 个模型可添加`;
      const canApply = Object.keys(buildApplyRequest(drafts, results).submitted).length > 0 && !busyOrSyncing;
      // Host-reported state of the process-wide switch; undefined until the
      // first status load, so the row renders a neutral "读取中" instead of
      // claiming a value the host never sent.
      const proxy = state?.proxy;
      const proxyReady = proxy !== undefined;
      const proxyOn = proxy?.enabled === true;
      const proxyNote = !proxyReady
        ? state === undefined
          ? "读取中…"
          : "当前运行的宿主版本还没有这个开关的状态；重启 DSH 后可用。"
        : !proxyOn
          ? "已关闭：目录检查与对话都直连。"
          : proxy.active
            ? `已接管：${proxy.url}（${proxy.source === "environment" ? "环境变量" : "系统设置"}）· 目录检查与对话都走代理`
            : proxy.reason ?? "已开启，但没有可用的系统代理；当前仍为直连。";
      const proxyNoteColor = proxyReady && proxyOn && !proxy.active ? ui.warning : ui.muted;

      return h(
        React.Fragment,
        null,
        h(
          "div",
          { style: { padding: "4px 2px" } },
          h("h2", { style: { margin: "0 0 3px" } }, "模型更新"),
          h("p", { style: { margin: "0 0 10px", color: ui.muted, fontSize: "13px" } }, "检查已配置供应商的完整模型目录。新增/移除按上次完整查看计算；只保存你的勾选与明确取消，不自动切换会话模型。"),
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
          h(
            "div",
            { style: { display: "flex", alignItems: "flex-start", gap: "9px", padding: "10px 12px", marginBottom: "10px", border: ui.border, borderRadius: ui.radius, background: ui.subtle } },
            h("input", {
              id: "model-sync-proxy",
              type: "checkbox",
              checked: proxyOn,
              disabled: busy !== "" || !proxyReady,
              "aria-describedby": "model-sync-proxy-note",
              onChange: (event) => changeProxy(event.target.checked),
              style: { marginTop: "2px", flex: "none" },
            }),
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "3px", minWidth: "0" } },
              h(
                "label",
                {
                  htmlFor: "model-sync-proxy",
                  title: "允许只使用系统代理就可以联通，不需要专门开虚拟网卡",
                  style: { cursor: "pointer", fontSize: "13px", color: "inherit" },
                },
                "通过系统代理访问模型服务",
                h(
                  "span",
                  { style: { color: ui.muted, fontSize: "12px", marginLeft: "6px" } },
                  proxyOn ? (proxy && proxy.active === true ? "已开启" : "已开启（未接管）") : "已关闭",
                ),
              ),
              h(
                "div",
                {
                  id: "model-sync-proxy-note",
                  role: "status",
                  "aria-live": "polite",
                  style: { color: proxyNoteColor, fontSize: "12px", lineHeight: "1.6" },
                },
                proxyNote,
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
                  totalAdd > 0 || totalRemove > 0 ? h("button", { type: "button", onClick: () => setDrafts({}), disabled: busyOrSyncing, style: { border: ui.border, borderRadius: "7px", padding: "6px 10px", background: "transparent", color: ui.muted, font: "inherit", fontSize: "12px", cursor: "pointer" } }, "清空全部待保存选择") : null,
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
      __test: { mergeModelGroups, transformDirectorySnapshot, resolveModelSelection, createMergedDirectory, providerName, editableResult, catalogSummary, captureExpansion, canAcknowledgeCatalog, mergeViewedCatalog, updateDraft, buildApplyRequest, clearAppliedDrafts, managedSiblingsFor, managedRowKey, managedRemovalIssue, managedRemovalEntry, buildManagedRemovalRequest, clearManagedRemovals, outcomeWarnings, ProviderCard, Panel, ManagedPanel },
    };
    return module.exports;
  },
});
