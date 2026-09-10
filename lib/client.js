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

    const ROUTE_LABELS = {
      "deepseek-official": "DeepSeek",
      "opencode-go": "OpenCode Go",
      "opencode-go-messages": "OpenCode Go · Anthropic",
      "opencode-go-responses": "OpenCode Go · Responses",
      "opencode-go-chat": "OpenCode Go · Chat",
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
                  newItems.length > 0 ? `发现 ${newItems.length} 个新模型（已选 ${checked.size}）` : "暂无新模型",
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
        newItems.length > 0
          ? h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "8px", flexWrap: "wrap" } },
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
            )
          : null,
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
    }

    const inject = ["slots"];

    module.exports = { apply, inject };
    return module.exports;
  },
});
