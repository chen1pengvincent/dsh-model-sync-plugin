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
    const defaultSelectedIds = (result) => (result.defaultSelected === false ? [] : (result.newItems ?? []).map((item) => item.id));

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
