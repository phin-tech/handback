<script lang="ts">
  import type { CheckResult, InputValue, Path, Session, SessionOutcome, Step, StepState, StepStatus } from "../../src/core.js";

  type PublicSession = Omit<Session, "token">;

  const token = new URLSearchParams(location.search).get("token") ?? "";
  let session = $state<PublicSession | null>(null);
  let checks = $state<Record<string, CheckResult[]>>({});
  let error = $state("");
  let returned = $state(false);
  let reason = $state("");
  let autoClose = $state(getCookie("handback_auto_close") === "1");
  let theme = $state<"system" | "light" | "dark">((localStorage.getItem("handback-theme") as "system" | "light" | "dark" | null) ?? "system");

  // Settings view + server-side config (Glimpse window options, persisted to ~/.config/handback).
  let showSettings = $state(false);
  let cfgFloating = $state(false);
  let cfgOpenLinksApp = $state("");
  let cfgApps = $state<{ label: string; value: string }[]>([]);
  let cfgSaved = $state(false);
  // "Custom…" lets the user type a path that wasn't discovered. We start in custom
  // mode when the saved value isn't one of the discovered apps.
  let customLinksApp = $state(false);

  // Per-step UI state (kept separate from session so polling never clobbers it).
  let collapsed = $state<Record<string, boolean>>({});
  let noteOpen = $state<Record<string, boolean>>({});
  let menuOpenId = $state("");
  let questionDraft = $state<Record<string, string>>({});

  // Dirty tracking for autosave / poll-merge: a step is "dirty" while it has local edits not
  // yet confirmed saved. We never overwrite a dirty step's inputs from a poll.
  let dirty = $state<Record<string, boolean>>({});
  const dirtyVersion: Record<string, number> = {};
  const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  // Previous locked/closed state, to drive auto-expand on unlock / auto-collapse on completion.
  const lockedPrev: Record<string, boolean> = {};
  const closedPrev: Record<string, boolean> = {};

  const finished = $derived(session?.status === "finished");
  const canFinish = $derived(
    Boolean(session && Object.values(session.steps).every((s) => s.status === "done" || s.status === "skipped"))
  );
  const progress = $derived(
    session
      ? {
          complete: Object.values(session.steps).filter((s) => s.status === "done" || s.status === "skipped").length,
          total: session.task.steps.length
        }
      : { complete: 0, total: 0 }
  );

  function isClosed(stepId: string): boolean {
    const s = session?.steps[stepId]?.status;
    return s === "done" || s === "skipped";
  }
  function blockersOf(step: Step): string[] {
    return (step.requires ?? []).filter((r) => !isClosed(r));
  }
  function isLocked(step: Step): boolean {
    const status = session?.steps[step.id]?.status;
    return blockersOf(step).length > 0 && !isClosed(step.id) && status !== "blocked";
  }
  function stepNumber(stepId: string): number {
    return (session?.task.steps.findIndex((s) => s.id === stepId) ?? 0) + 1;
  }
  function activePath(step: Step, state: StepState): Path | undefined {
    if (!step.paths || step.paths.length === 0) return undefined;
    return step.paths.find((p) => p.id === state.selectedPath) ?? step.paths[0];
  }
  function outcomeLabel(step: Step, state: StepState): string {
    if (state.status !== "done") return state.status;
    return activePath(step, state)?.outcome ?? "done";
  }
  function isAlt(step: Step, state: StepState): boolean {
    return state.status === "done" && Boolean(activePath(step, state)?.outcome);
  }
  function agentWaiting(): boolean {
    return Boolean(session?.agentWaitingUntil && Date.parse(session.agentWaitingUntil) > Date.now());
  }

  // ---- collapse defaults & transitions -------------------------------------
  function initCollapse(): void {
    const next: Record<string, boolean> = {};
    for (const step of session!.task.steps) {
      const closed = isClosed(step.id);
      const locked = isLocked(step);
      next[step.id] = closed || locked;
      closedPrev[step.id] = closed;
      lockedPrev[step.id] = locked;
    }
    collapsed = next;
  }
  function reconcileCollapse(): void {
    if (!session) return;
    for (const step of session.task.steps) {
      const id = step.id;
      const closed = isClosed(id);
      const locked = isLocked(step);
      if (closed && !closedPrev[id]) collapsed[id] = true; // just completed → tuck away
      if (!closed && lockedPrev[id] && !locked) collapsed[id] = false; // just unlocked → reveal
      closedPrev[id] = closed;
      lockedPrev[id] = locked;
    }
  }

  // ---- networking ----------------------------------------------------------
  function mergeSession(incoming: PublicSession): PublicSession {
    if (!session) return incoming;
    const mergedSteps: Record<string, StepState> = {};
    for (const [id, inState] of Object.entries(incoming.steps)) {
      const local = session.steps[id];
      mergedSteps[id] = local && dirty[id] ? { ...inState, inputs: local.inputs, selectedPath: local.selectedPath } : inState;
    }
    return { ...incoming, steps: mergedSteps };
  }

  async function load(): Promise<void> {
    const res = await fetch(`/api/status?token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "failed to load");
    const first = !session;
    session = mergeSession(data.session);
    checks = data.checks ?? {};
    if (first) initCollapse();
    else reconcileCollapse();
  }

  async function updateStep(stepId: string, status: StepStatus): Promise<void> {
    if (!session) return;
    const state = session.steps[stepId];
    clearTimeout(saveTimers[stepId]);
    delete dirty[stepId];
    const res = await fetch(`/api/steps/${encodeURIComponent(stepId)}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, inputs: state.inputs, selectedPath: state.selectedPath })
    });
    const data = await res.json();
    if (!res.ok) {
      error = data.error ?? "update failed";
      return;
    }
    session = mergeSession(data);
    error = "";
    reconcileCollapse();
  }

  async function askAgent(stepId: string): Promise<void> {
    const text = (questionDraft[stepId] ?? "").trim();
    if (!text) return;
    const res = await fetch(`/api/steps/${encodeURIComponent(stepId)}/questions?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (!res.ok) {
      error = data.error ?? "question failed";
      return;
    }
    questionDraft[stepId] = "";
    session = mergeSession(data.session);
    error = "";
  }

  function scheduleSave(stepId: string): void {
    dirty[stepId] = true;
    const v = (dirtyVersion[stepId] = (dirtyVersion[stepId] ?? 0) + 1);
    clearTimeout(saveTimers[stepId]);
    saveTimers[stepId] = setTimeout(() => autosave(stepId, v), 600);
  }
  async function autosave(stepId: string, v: number): Promise<void> {
    const state = session?.steps[stepId];
    if (!state) return;
    try {
      const res = await fetch(`/api/steps/${encodeURIComponent(stepId)}?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputs: state.inputs, selectedPath: state.selectedPath })
      });
      if (res.ok && dirtyVersion[stepId] === v) delete dirty[stepId];
    } catch {
      /* keep dirty; next poll/save retries */
    }
  }

  async function finish(outcome: SessionOutcome): Promise<void> {
    const res = await fetch(`/api/finish?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome, reason })
    });
    const data = await res.json();
    if (!res.ok) {
      error = data.error ?? "finish failed";
      return;
    }
    returned = true;
    error = "";
    if (session) session = { ...session, status: "finished" };
    if (autoClose) setTimeout(closeWindow, 250);
  }

  // In a Glimpse native window, window.close() is a no-op — ask the host to close
  // itself via the injected `glimpse.close` bridge, falling back to window.close().
  function closeWindow(): void {
    const glimpseClose = (window as unknown as { glimpse?: { close?: () => void } }).glimpse?.close;
    if (typeof glimpseClose === "function") glimpseClose();
    else window.close();
  }

  // ---- local input handling ------------------------------------------------
  function value(stepId: string, inputId: string): InputValue | undefined {
    return session?.steps[stepId]?.inputs[inputId];
  }
  function stringValue(stepId: string, inputId: string): string {
    const v = value(stepId, inputId);
    return typeof v === "string" ? v : "";
  }
  function setValue(stepId: string, inputId: string, next: InputValue): void {
    const state = session?.steps[stepId];
    if (!state) return;
    state.inputs[inputId] = next;
    scheduleSave(stepId);
  }
  function toggleConfirm(stepId: string, confirmId: string): void {
    setValue(stepId, confirmId, !value(stepId, confirmId));
  }
  function selectPath(stepId: string, pathId: string): void {
    const state = session?.steps[stepId];
    if (!state) return;
    state.selectedPath = pathId;
    scheduleSave(stepId);
  }

  // ---- box / menu / collapse interactions ----------------------------------
  function toggleComplete(step: Step): void {
    if (finished || isLocked(step)) return;
    const status = session?.steps[step.id].status;
    updateStep(step.id, status === "done" ? "pending" : "done");
  }
  function toggleCollapse(stepId: string): void {
    collapsed[stepId] = !collapsed[stepId];
  }
  function openMenu(stepId: string, event: MouseEvent): void {
    event.stopPropagation();
    menuOpenId = menuOpenId === stepId ? "" : stepId;
  }
  function copy(text: string, event: MouseEvent): void {
    event.stopPropagation();
    navigator.clipboard?.writeText(text);
  }

  function setTheme(next: "system" | "light" | "dark"): void {
    theme = next;
    localStorage.setItem("handback-theme", next);
  }
  function cycleTheme(): void {
    setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system");
  }
  function setAutoClose(next: boolean): void {
    autoClose = next;
    document.cookie = `handback_auto_close=${next ? "1" : "0"}; Path=/; SameSite=Lax; Max-Age=31536000`;
  }

  // Glimpse window options live server-side (they shape the next `glimpseui` spawn),
  // so load/save them through /api/config rather than browser storage.
  async function loadSettings(): Promise<void> {
    try {
      const res = await fetch(`/api/config?token=${encodeURIComponent(token)}`);
      if (!res.ok) return;
      applyConfig(await res.json());
      // Decide the initial dropdown mode once, from the loaded value.
      customLinksApp = Boolean(cfgOpenLinksApp) && !cfgApps.some((a) => a.value === cfgOpenLinksApp);
    } catch {
      /* settings are optional; ignore */
    }
  }
  function applyConfig(cfg: { floating?: boolean; openLinksApp?: string; apps?: { label: string; value: string }[] }): void {
    cfgFloating = Boolean(cfg.floating);
    cfgOpenLinksApp = String(cfg.openLinksApp ?? "");
    if (Array.isArray(cfg.apps)) cfgApps = cfg.apps;
  }
  async function saveSettings(patch: Record<string, unknown>): Promise<void> {
    cfgSaved = false;
    try {
      const res = await fetch(`/api/config?token=${encodeURIComponent(token)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (!res.ok) return;
      applyConfig(await res.json());
      cfgSaved = true;
      setTimeout(() => (cfgSaved = false), 1500);
    } catch {
      /* ignore */
    }
  }
  // Dropdown change: "" = system default, "__custom__" = reveal the path field,
  // anything else = a discovered app path we can save immediately.
  function onLinksAppSelect(value: string): void {
    if (value === "__custom__") {
      customLinksApp = true;
      return;
    }
    customLinksApp = false;
    cfgOpenLinksApp = value;
    saveSettings({ openLinksApp: value });
  }
  function getCookie(name: string): string | undefined {
    return document.cookie
      .split("; ")
      .find((part) => part.startsWith(`${name}=`))
      ?.split("=")[1];
  }

  load().catch((err) => (error = err.message));
  loadSettings().catch(() => undefined);
  setInterval(() => load().catch(() => undefined), 1000);
  $effect(() => {
    document.documentElement.dataset.theme = theme;
  });
</script>

<svelte:window onclick={() => (menuOpenId = "")} />

{#if session}
  <header class="topbar">
    <span class="brand">handback</span>
    <h1>{session.task.title}</h1>
    <span class="spacer"></span>
    <div class="meter" aria-hidden="true">
      <span style={`width: ${progress.total ? (progress.complete / progress.total) * 100 : 0}%`}></span>
    </div>
    <span class="count">{progress.complete} / {progress.total}</span>
    <button class="theme-toggle" title={`Theme: ${theme}`} aria-label={`Theme: ${theme}`} onclick={cycleTheme}
      >{theme === "system" ? "◐" : theme === "light" ? "☼" : "☾"}</button>
    <button class="theme-toggle" title="Settings" aria-label="Settings" onclick={() => (showSettings = true)}>⚙</button>
    <button class="finish" disabled={!canFinish || finished} onclick={() => finish("completed")}>Finish</button>
  </header>

  {#if showSettings}
    <div class="settings-backdrop" role="presentation" onclick={() => (showSettings = false)}></div>
    <div class="settings-panel" role="dialog" aria-label="Settings" aria-modal="true">
      <header class="settings-head">
        <h3>Settings</h3>
        <button class="settings-close" aria-label="Close settings" onclick={() => (showSettings = false)}>✕</button>
      </header>

      <section class="settings-group">
        <h4>Appearance</h4>
        <label class="settings-row">
          <span>Theme</span>
          <select value={theme} onchange={(e) => setTheme(e.currentTarget.value as "system" | "light" | "dark")}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </section>

      <section class="settings-group">
        <h4>Behavior</h4>
        <label class="settings-row toggle">
          <input type="checkbox" checked={autoClose} onchange={(e) => setAutoClose(e.currentTarget.checked)} />
          <span>Auto-close window after returning to the agent</span>
        </label>
      </section>

      <section class="settings-group">
        <h4>Native window</h4>
        <p class="settings-hint">Applies to the Glimpse native window the next time a runbook opens.</p>
        <label class="settings-row toggle">
          <input type="checkbox" checked={cfgFloating} onchange={(e) => saveSettings({ floating: e.currentTarget.checked })} />
          <span>Float above other windows</span>
        </label>
        <label class="settings-row">
          <span>Open links in</span>
          <select
            value={customLinksApp ? "__custom__" : cfgOpenLinksApp}
            onchange={(e) => onLinksAppSelect(e.currentTarget.value)}
          >
            <option value="">System default</option>
            {#each cfgApps as app}
              <option value={app.value}>{app.label}</option>
            {/each}
            <option value="__custom__">Custom…</option>
          </select>
        </label>
        {#if customLinksApp}
          <label class="settings-row">
            <span>App path</span>
            <input type="text" placeholder="/Applications/Linear.app" bind:value={cfgOpenLinksApp} onchange={() => saveSettings({ openLinksApp: cfgOpenLinksApp })} />
          </label>
        {/if}
        <p class="settings-hint">Send http/https links to a specific app — e.g. point it at Linear to open <code>linear.app</code> links in the desktop app. Detected apps are listed; choose “Custom…” for a full path. Defaults to the system browser.</p>
      </section>

      {#if cfgSaved}<div class="settings-saved" role="status">Saved</div>{/if}
    </div>
  {/if}

  <main class="doc">
    <header class="doc-head">
      <div class="kicker">Runbook · returned by agent</div>
      <h2>{session.task.title}</h2>
    </header>

    {#each session.task.steps as step, index (step.id)}
      {@const state = session.steps[step.id]}
      {@const status = state.status}
      {@const closedStep = status === "done" || status === "skipped"}
      {@const blockers = blockersOf(step)}
      {@const locked = isLocked(step)}
      {@const collapsedStep = collapsed[step.id] ?? false}
      {@const ap = activePath(step, state)}
      {@const activePathId = ap?.id}
      <section
        class="step"
        class:done={status === "done"}
        class:skipped={status === "skipped"}
        class:blocked={status === "blocked"}
        class:locked
        class:collapsed={collapsedStep}
        class:alt={isAlt(step, state)}
      >
        <button class="box" disabled={finished || locked} title="Mark complete" onclick={() => toggleComplete(step)}></button>

        <div
          class="step-head"
          role="button"
          tabindex="0"
          onclick={() => toggleCollapse(step.id)}
          onkeydown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggleCollapse(step.id))}
        >
          <span class="num">{index + 1}</span>
          <span class="title">{step.title}</span>
          {#if step.source}
            {#if step.source.href}
              <a class={"loc " + step.source.kind} href={step.source.href} target="_blank" rel="noreferrer" onclick={(e) => e.stopPropagation()}>{step.source.label}</a>
            {:else}
              <span class={"loc " + step.source.kind}>{step.source.label}</span>
            {/if}
          {/if}
          <span class="head-spacer"></span>
          {#if status !== "pending"}<span class="pill-state">{outcomeLabel(step, state)}</span>{/if}
          <span class="chev">▾</span>
          <div class="more">
            <button aria-label="More actions" onclick={(e) => openMenu(step.id, e)}>⋯</button>
            {#if menuOpenId === step.id}
              <div class="menu">
                <button disabled={finished || locked} onclick={(e) => (e.stopPropagation(), (menuOpenId = ""), updateStep(step.id, "done"))}>Mark complete</button>
                <button disabled={finished} onclick={(e) => (e.stopPropagation(), (menuOpenId = ""), updateStep(step.id, "skipped"))}>Skip step</button>
                <button class="warn" disabled={finished} onclick={(e) => (e.stopPropagation(), (menuOpenId = ""), updateStep(step.id, "blocked"))}>Block step</button>
              </div>
            {/if}
          </div>
        </div>

        {#if locked && blockers.length}
          <span class="blockedby unmet"><span class="ic">🔒</span> blocked by {blockers.map((b) => stepNumber(b)).join(", ")}</span>
        {:else if !closedStep && (step.requires?.length ?? 0) > 0}
          <span class="blockedby met"><span class="ic">✓</span> after {(step.requires ?? []).map((b) => stepNumber(b)).join(", ")}</span>
        {/if}

        {#if !collapsedStep}
          <div class="step-body">
            <div class="step-main">
              {#if step.note}
                <div class="ai-note" class:open={noteOpen[step.id]}>
                  <button type="button" class="who" onclick={(e) => (e.stopPropagation(), (noteOpen[step.id] = !noteOpen[step.id]))}
                    >◆ agent note <span class="tw">▾</span></button>
                  <div class="note-body"><p>{step.note}</p></div>
                </div>
              {/if}

              {#if step.body}<p class="body">{step.body}</p>{/if}

              {#if step.links?.length}
                <div class="links">{#each step.links as link}<a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>{/each}</div>
              {/if}

              {#if step.commands?.length}
                {#each step.commands as command}
                  <div class="fence"><button class="copy" onclick={(e) => copy(command, e)}>copy</button><pre>{command}</pre></div>
                {/each}
              {/if}

              {#if step.checks?.length}
                <div class="checks">
                  {#each step.checks as check}
                    {@const result = checks[step.id]?.find((c) => c.id === check.id)}
                    {@const cs = result?.status ?? "pending"}
                    {#if cs === "unavailable"}
                      {@const manual = Boolean(value(step.id, check.id))}
                      <button
                        type="button"
                        disabled={finished || locked}
                        class={"check manual" + (manual ? " pass" : "")}
                        onclick={() => toggleConfirm(step.id, check.id)}
                      >
                        <span class="glyph">{manual ? "✓" : "?"}</span>
                        <span class="label">{check.label}</span>
                        <span class="dots"></span>
                        <span class="auto">verify</span>
                        <span class="verdict">{manual ? "verified" : "—"}</span>
                      </button>
                    {:else}
                      <div class={"check " + cs}>
                        <span class="glyph">{cs === "pass" ? "✓" : cs === "fail" ? "✗" : "◌"}</span>
                        <span class="label">{check.label}</span>
                        <span class="dots"></span>
                        <span class="auto">auto</span>
                        <span class="verdict">{cs}</span>
                      </div>
                    {/if}
                  {/each}
                </div>
              {/if}

              {#if step.paths?.length}
                <div class="paths" role="tablist">
                  {#each step.paths as p}
                    <button
                      type="button"
                      role="tab"
                      class="path-opt"
                      class:fallback={Boolean(p.outcome)}
                      aria-selected={activePathId === p.id}
                      onclick={(e) => (e.stopPropagation(), selectPath(step.id, p.id))}>{p.label}</button>
                  {/each}
                </div>
                {#if ap}
                  <div class="path-pane" class:fallback={Boolean(ap.outcome)}>
                    {#if ap.body}<p class="body">{ap.body}</p>{/if}
                    {#if ap.links?.length}
                      <div class="links">{#each ap.links as link}<a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>{/each}</div>
                    {/if}
                    {#if ap.commands?.length}
                      {#each ap.commands as command}
                        <div class="fence"><button class="copy" onclick={(e) => copy(command, e)}>copy</button><pre>{command}</pre></div>
                      {/each}
                    {/if}
                    {#if ap.confirms?.length}
                      {#each ap.confirms as c}
                        <button type="button" class="confirm" role="checkbox" aria-checked={Boolean(value(step.id, c.id))} onclick={() => toggleConfirm(step.id, c.id)}>
                          <span class="toggle"></span>
                          <span class="confirm-label">{c.label}{c.required ? " *" : ""}</span>
                        </button>
                      {/each}
                    {/if}
                  </div>
                {/if}
              {/if}

              {#if step.confirms?.length}
                {#each step.confirms as c}
                  <button type="button" class="confirm" role="checkbox" aria-checked={Boolean(value(step.id, c.id))} onclick={() => toggleConfirm(step.id, c.id)}>
                    <span class="toggle"></span>
                    <span class="confirm-label">{c.label}{c.required ? " *" : ""}</span>
                  </button>
                {/each}
              {/if}

              {#if step.inputs?.length}
                {#each step.inputs as input}
                  <div class="field">
                    <label for={`f-${step.id}-${input.id}`}>{input.label}{input.required ? " *" : ""}</label>
                    {#if input.kind === "textarea"}
                      <textarea id={`f-${step.id}-${input.id}`} value={stringValue(step.id, input.id)} oninput={(e) => setValue(step.id, input.id, e.currentTarget.value)}></textarea>
                    {:else if input.kind === "checkbox"}
                      <input id={`f-${step.id}-${input.id}`} type="checkbox" checked={Boolean(value(step.id, input.id))} onchange={(e) => setValue(step.id, input.id, e.currentTarget.checked)} />
                    {:else if input.kind === "select"}
                      <select id={`f-${step.id}-${input.id}`} value={stringValue(step.id, input.id)} onchange={(e) => setValue(step.id, input.id, e.currentTarget.value)}>
                        <option value=""></option>
                        {#each input.options as option}<option value={option}>{option}</option>{/each}
                      </select>
                    {:else if input.kind === "multiselect"}
                      <div class="pills">
                        {#each input.options as option}
                          {@const sel = (value(step.id, input.id) ?? []) as string[]}
                          <button
                            type="button"
                            class="pill"
                            aria-pressed={sel.includes(option)}
                            onclick={() => setValue(step.id, input.id, sel.includes(option) ? sel.filter((o) => o !== option) : [...sel, option])}>{option}</button>
                        {/each}
                      </div>
                    {:else}
                      <input id={`f-${step.id}-${input.id}`} type="text" value={stringValue(step.id, input.id)} oninput={(e) => setValue(step.id, input.id, e.currentTarget.value)} />
                    {/if}
                  </div>
                {/each}
              {/if}
            </div>

            {#if state.questions?.length || (step.askable !== false && agentWaiting())}
              <div class="ask">
                {#if state.questions?.length}
                  <div class="thread">
                    {#each state.questions as question}
                      <div class="turn human"><span>you</span><p>{question.text}</p></div>
                      {#if question.answer}
                        <div class="turn agent"><span>agent</span><p>{question.answer}</p></div>
                      {:else}
                        <div class="turn pending"><span>agent</span><p>waiting</p></div>
                      {/if}
                    {/each}
                  </div>
                {/if}
                {#if step.askable !== false && agentWaiting()}
                  <div class="ask-row">
                    <input
                      type="text"
                      placeholder="Ask the agent"
                      value={questionDraft[step.id] ?? ""}
                      disabled={finished}
                      oninput={(e) => (questionDraft[step.id] = e.currentTarget.value)}
                      onkeydown={(e) => e.key === "Enter" && (e.preventDefault(), askAgent(step.id))}
                    />
                    <button type="button" disabled={finished || !(questionDraft[step.id] ?? "").trim()} onclick={() => askAgent(step.id)}>Ask</button>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </section>
    {/each}

    <footer class="doc-foot">
      {#if error}<div class="banner error">{error}</div>{/if}
      {#if returned}<div class="banner returned">Returned to agent. You can close this tab.</div>{/if}
      <label class="auto-close">
        <input type="checkbox" checked={autoClose} onchange={(e) => setAutoClose(e.currentTarget.checked)} />
        <span>Auto-close after return</span>
      </label>
      <textarea class="reason" placeholder="Reason (optional)" bind:value={reason}></textarea>
      <div class="foot-actions">
        <button class="primary" disabled={!canFinish || finished} onclick={() => finish("completed")}>Finish</button>
        <button disabled={finished} onclick={() => finish("incomplete")}>Finish incomplete</button>
        <button class="danger" disabled={finished} onclick={() => finish("cancelled")}>Cancel</button>
      </div>
    </footer>
  </main>
{:else}
  <div class="loading">{error || "Loading handback…"}</div>
{/if}
