window.__ModuleLoader__.load({
  id: "dsh-model-sync",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const API = "/model-sync/api";

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
    const defaultSelectedIds = (result) => (result.defaultSelected === false ? [] : (result.newItems ?? []).map((item) => item.id));

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
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    }

    function Hint(props) {
      return h("p", { style: { margin: "4px 0 0", fontSize: "12px", color: props.tone ?? "#57606a" } }, props.children);
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
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [expanded, setExpanded] = useState(() => new Set());

      const load = useCallback(async () => {
        try {
          setPayload(await api("/managed"));
          setError("");
        } catch (err) {
          setError(err.message);
        }
      }, []);

      useEffect(() => {
        if (!active) return undefined;
        void load();
        const onUpdate = () => {
          void load();
        };
        window.addEventListener("dsh-model-sync:updated", onUpdate);
        return () => window.removeEventListener("dsh-model-sync:updated", onUpdate);
      }, [active, load]);

      if (!active) return null;
      const prefix = officialClassPrefix();
      if (prefix === undefined) return null;
      const route = (payload?.routes ?? []).find((entry) => entry.provider === providerId);
      if (route === undefined) return null;
      const rows = route.siblings.flatMap((sibling) => sibling.models.map((model) => ({ sibling, model })));
      if (rows.length === 0) return null;
      const cls = (name) => `${prefix}${name}`;

      const toggle = (key) => {
        setExpanded((current) => {
          const next = new Set(current);
          if (!next.delete(key)) next.add(key);
          return next;
        });
      };

      const remove = async (sibling, model) => {
        const name = model.name !== undefined && model.name.length > 0 ? model.name : model.id;
        if (!window.confirm(`移除「${name}」？移除后它不再出现在 DSH 的模型选择中；可在「设置 → 模型更新」里重新添加。`)) return;
        const key = `${sibling.provider}:${model.id}`;
        setBusy(key);
        setError("");
        try {
          await api("/remove", { method: "POST", body: JSON.stringify({ provider: sibling.provider, modelId: model.id }) });
          window.dispatchEvent(new Event("dsh-model-sync:updated"));
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy("");
        }
      };

      return h(
        "div",
        { className: cls("modelCatalog") },
        h(
          "div",
          { className: cls("modelCatalogHeading") },
          h("span", { className: cls("modelCatalogTitle") }, "协议分流模型（由插件托管）"),
          h("p", { className: cls("modelCatalogMeta") }, "删除后可从「模型更新」重新添加"),
        ),
        error.length > 0 ? h("p", { className: cls("error") }, error) : null,
        h(
          "div",
          { className: cls("modelList") },
          rows.map(({ sibling, model }) => {
            const key = `${sibling.provider}:${model.id}`;
            const isOpen = expanded.has(key);
            const modalities = Array.isArray(model.input) && model.input.length > 0 ? model.input : ["text"];
            return h(
              "div",
              { key, className: cls("modelEntry") },
              h(
                "div",
                { className: cls("modelRow") },
                h("input", { className: cls("input"), type: "text", value: model.id, readOnly: true, "aria-label": `模型 ID ${model.id}` }),
                h("input", { className: cls("input"), type: "text", value: model.name ?? model.id, readOnly: true, "aria-label": `模型名称 ${model.id}` }),
                h(
                  "button",
                  { type: "button", className: cls("iconButton"), "aria-expanded": isOpen, title: "高级设置", onClick: () => toggle(key) },
                  isOpen ? h(ChevronDownIcon, {}) : h(ChevronRightIcon, {}),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: `${cls("iconButton")} ${cls("iconButtonDanger")}`,
                    title: "移除",
                    disabled: busy !== "",
                    onClick: () => void remove(sibling, model),
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
                        placeholder: "256K",
                        "aria-label": "上下文窗口",
                      }),
                    ),
                    h(
                      "label",
                      { className: cls("modelField") },
                      h("span", { className: cls("modelFieldLabel") }, "最大输出"),
                      h("input", {
                        className: cls("input"),
                        type: "text",
                        inputMode: "numeric",
                        value: model.maxTokens === undefined ? "" : formatCapacity(model.maxTokens),
                        readOnly: true,
                        placeholder: "32K",
                        "aria-label": "最大输出",
                      }),
                    ),
                    Checkbox === undefined
                      ? null
                      : h(
                          "fieldset",
                          { className: cls("modelInputTypes"), "aria-label": `输入类型 ${model.id}` },
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
        ),
      );
    }

    function smallButton(labelText, onClick, disabled) {
      return h(
        "button",
        {
          type: "button",
          onClick,
          disabled,
          style: {
            border: "none",
            background: "none",
            padding: 0,
            color: "#0969da",
            fontSize: "12px",
            cursor: disabled ? "default" : "pointer",
          },
        },
        labelText,
      );
    }

    function UpdateCard(props) {
      const { result, checked, toggle, managed, onManagedChange, query, onQuery, setMany, busy } = props;
      const newItems = Array.isArray(result.newItems) ? result.newItems : [];
      const repairs = Array.isArray(result.repairs) ? result.repairs : [];
      const removed = Array.isArray(result.removed) ? result.removed : [];
      const skipped = Array.isArray(result.skipped) ? result.skipped : [];
      const filtered = query.length === 0
        ? newItems
        : newItems.filter((item) => `${item.id} ${item.name ?? ""}`.toLowerCase().includes(query.toLowerCase()));
      const visible = filtered.slice(0, 200);

      return h(
        "div",
        { style: { border: "1px solid #d0d7de", borderRadius: "10px", padding: "12px 14px", marginBottom: "10px" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
          h("strong", null, label(result.provider)),
          result.status === "discovery-failed"
            ? h("span", { style: { color: "#cf222e", fontSize: "12px" } }, `检查失败：${result.error}`)
            : result.status === "unmanaged"
              ? h("span", { style: { color: "#8c959f", fontSize: "12px" } }, managed ? "已纳入但不在 settings 中" : "未纳入检查")
              : h(
                  "span",
                  { style: { color: "#57606a", fontSize: "12px" } },
                  newItems.length > 0 ? `发现 ${newItems.length} 个新模型` : "暂无新模型",
                ),
          h(
            "label",
            { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" } },
            h("input", {
              type: "checkbox",
              checked: managed,
              disabled: busy !== "",
              onChange: (event) => onManagedChange(result.provider, event.target.checked),
            }),
            "纳入检查",
          ),
        ),
        result.credential && result.credential.shadowed === true
          ? h(
              "div",
              { style: { marginTop: "8px", padding: "8px 10px", borderRadius: "8px", background: "#fff8c5", border: "1px solid #eac54f", color: "#6b4f00", fontSize: "12px", lineHeight: 1.5 } },
              `⚠️ ${result.credential.warning ?? `凭证 ${result.credential.ref} 被启动环境变量遮蔽，设置页只读`}`,
            )
          : null,
        newItems.length > 0
          ? h(
              "details",
              { style: { marginTop: "8px" } },
              h(
                "summary",
                { style: { fontSize: "13px", color: "#0969da", cursor: "pointer" } },
                `选择要添加的模型（${newItems.length} 个，已选 ${checked.size}）`,
              ),
              h(
                "div",
                { style: { marginTop: "8px" } },
                h(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
                  h("input", {
                    type: "text",
                    value: query,
                    placeholder: "搜索模型 id / 名称",
                    onChange: (event) => onQuery(result.provider, event.target.value),
                    style: { flex: "1 1 220px", minWidth: "180px", height: "30px", padding: "0 10px", borderRadius: "8px", border: "1px solid #d0d7de", fontSize: "13px" },
                  }),
                  smallButton("全选", () => setMany(result.provider, filtered.map((item) => item.id), true), filtered.length === 0),
                  smallButton("清空", () => setMany(result.provider, filtered.map((item) => item.id), false), filtered.length === 0),
                  query.length > 0 ? h("span", { style: { color: "#8c959f", fontSize: "12px" } }, `筛选出 ${filtered.length} 个`) : null,
                ),
                filtered.length > 0
                  ? h(
                      "ul",
                      { style: { listStyle: "none", margin: "8px 0 0", padding: 0 } },
                      visible.map((item) =>
                        h(
                          "li",
                          { key: item.id, style: { margin: "2px 0" } },
                          h(
                            "label",
                            { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" } },
                            h("input", { type: "checkbox", checked: checked.has(item.id), onChange: () => toggle(result.provider, item.id) }),
                            h("span", null, modelName(item)),
                            item.target !== result.provider ? h("span", { style: { color: "#57606a", fontSize: "12px" } }, `→ ${label(item.target)}`) : null,
                          ),
                        ),
                      ),
                      filtered.length > visible.length
                        ? h(Hint, { tone: "#8c959f" }, `列表过大，仅显示前 ${visible.length} 个；请用搜索缩小范围（共 ${filtered.length} 个）`)
                        : null,
                    )
                  : null,
              ),
            )
          : null,
        repairs.length > 0
          ? h(
              "label",
              { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", color: "#9a6700", marginTop: "6px" } },
              h("input", { type: "checkbox", checked: props.repairsChecked, onChange: props.toggleRepairs }),
              h("span", null, `协议修正 ${repairs.length} 个模型（自动移到正确路由）`),
            )
          : null,
        removed.length > 0
          ? h(Hint, { tone: "#8c959f" }, `上游已不再提供（仅提示，不会删除）：${removed.map((entry) => entry.id).join(", ")}`)
          : null,
        skipped.length > 0 ? h(Hint, { tone: "#9a6700" }, `跳过：${skipped.map((entry) => `${entry.id}（${entry.reason}）`).join("；")}`) : null,
        h(
          "details",
          { style: { marginTop: "8px" } },
          h("summary", { style: { fontSize: "12px", color: "#8c959f", cursor: "pointer" } }, "技术细节"),
          h(
            "div",
            { style: { fontSize: "12px", color: "#57606a", marginTop: "4px" } },
            result.discoveryBase ? h("div", null, `上游: ${result.discoveryBase}`) : null,
            typeof result.discovered === "number" ? h("div", null, `上游模型总数: ${result.discovered}`) : null,
            newItems.length > 0
              ? h("div", null, `放置: ${newItems.map((item) => `${item.id} → ${label(item.target)}（${item.api}）`).join("；")}`)
              : null,
          ),
        ),
      );
    }

    function Panel() {
      const [state, setState] = useState(undefined);
      const [checked, setChecked] = useState({});
      const [queries, setQueries] = useState({});
      const [repairsChecked, setRepairsChecked] = useState(true);
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [message, setMessage] = useState("");

      const refresh = useCallback(async () => {
        try {
          setState(await api("/state"));
          setError("");
        } catch (err) {
          setError(err.message);
        }
      }, []);

      const initSelections = useCallback((results) => {
        const next = {};
        for (const result of results ?? []) next[result.provider] = new Set(defaultSelectedIds(result));
        return next;
      }, []);

      const check = useCallback(async () => {
        setBusy("check");
        setError("");
        setMessage("");
        try {
          const payload = await api("/check", { method: "POST" });
          setChecked(initSelections(payload.results));
          setRepairsChecked(true);
          await refresh();
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy("");
        }
      }, [initSelections, refresh]);

      useEffect(() => {
        void refresh();
      }, [refresh]);

      useEffect(() => {
        const lastCheck = state?.lastCheck;
        if (lastCheck === undefined || lastCheck === null) return;
        setChecked((current) => (Object.keys(current).length > 0 ? current : initSelections(lastCheck.results)));
      }, [state?.lastCheck?.at, initSelections]);

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

      const setQuery = useCallback((provider, value) => {
        setQueries((current) => ({ ...current, [provider]: value }));
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
        setBusy("apply");
        setError("");
        setMessage("");
        try {
          const selections = {};
          for (const [provider, set] of Object.entries(checked)) {
            if (set.size > 0) selections[provider] = [...set];
          }
          const outcome = await api("/apply", { method: "POST", body: JSON.stringify({ selections, repairs: repairsChecked }) });
          const added = (outcome.applied ?? []).reduce((total, entry) => total + (entry.added ?? 0), 0);
          setMessage(added > 0 ? `已添加 ${added} 个模型，可在「模型」中查看` : "没有需要添加的模型");
          if ((outcome.errors ?? []).length > 0) setError(outcome.errors.join("; "));
          setChecked({});
          await refresh();
          window.dispatchEvent(new Event("dsh-model-sync:updated"));
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy("");
        }
      }, [checked, repairsChecked, refresh]);

      const results = useMemo(() => state?.lastCheck?.results ?? [], [state]);
      const totalChecked = useMemo(() => Object.values(checked).reduce((total, set) => total + set.size, 0), [checked]);
      const anyRepairs = useMemo(() => results.some((result) => (result.repairs ?? []).length > 0), [results]);

      return h(
        "div",
        { style: { padding: "4px 2px" } },
        h("h2", { style: { margin: "0 0 4px" } }, "模型更新"),
        h(
          "p",
          { style: { margin: "0 0 12px", color: "#57606a", fontSize: "13px" } },
          "检查各 provider 上游是否发布了新模型。勾选后点「添加所选」，即可在「模型」设置和会话模型选择器里使用。不会删除或改写已有条目。",
        ),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "12px" } },
          h("button", { type: "button", onClick: check, disabled: busy !== "" }, busy === "check" ? "检查中…" : "检查更新"),
          h(
            "button",
            { type: "button", onClick: apply, disabled: busy !== "" || (totalChecked === 0 && !(repairsChecked && anyRepairs)) },
            busy === "apply" ? "添加中…" : `添加所选${totalChecked > 0 ? `（${totalChecked}）` : ""}`,
          ),
          h("span", { style: { color: "#57606a", fontSize: "12px" } }, `上次检查：${formatTime(state?.lastCheck?.at)}`),
          state?.lastApply ? h("span", { style: { color: "#57606a", fontSize: "12px" } }, `上次添加：${formatTime(state.lastApply.at)}`) : null,
        ),
        message ? h("p", { style: { color: "#1a7f37", fontSize: "13px" } }, message) : null,
        error ? h("p", { style: { color: "#cf222e", fontSize: "13px" } }, error) : null,
        state === undefined
          ? h("p", { style: { color: "#57606a" } }, "加载中…")
          : results.length === 0
            ? h("p", { style: { color: "#57606a" } }, "尚未检查过。点「检查更新」开始。")
            : results.map((result) =>
                h(UpdateCard, {
                  key: result.provider,
                  result,
                  checked: checked[result.provider] ?? new Set(),
                  toggle,
                  setMany,
                  managed: state.managed?.[result.provider] === true,
                  onManagedChange: changeManaged,
                  query: queries[result.provider] ?? "",
                  onQuery: setQuery,
                  repairsChecked,
                  toggleRepairs: () => setRepairsChecked((value) => !value),
                  busy,
                }),
              ),
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
    }

    const inject = ["slots"];

    module.exports = { apply, inject };
    return module.exports;
  },
});
