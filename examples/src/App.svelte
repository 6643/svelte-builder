<script>
  let count = $state(0);
  let LazyButtonDemo = $state(null);
  let LazyViewDemo = $state(null);
  let activeView = $state("home");
  let buttonError = $state("");
  let viewError = $state("");
  let isButtonLoading = $state(false);
  let isViewLoading = $state(false);

  const increment = () => count++;

  const loadButtonDemo = async () => {
    if (LazyButtonDemo || isButtonLoading) return;

    buttonError = "";
    isButtonLoading = true;

    const result = await import("./lazy/ButtonDemo.svelte").then(
      (module) => ({ ok: true, value: module.default }),
      (error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    );

    isButtonLoading = false;
    if (!result.ok) {
      buttonError = result.error;
      return;
    }

    LazyButtonDemo = result.value;
  };

  const showHome = () => {
    activeView = "home";
  };

  const showDetails = async () => {
    activeView = "details";
    if (LazyViewDemo || isViewLoading) return;

    viewError = "";
    isViewLoading = true;

    const result = await import("./lazy/ViewDemo.svelte").then(
      (module) => ({ ok: true, value: module.default }),
      (error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    );

    isViewLoading = false;
    if (!result.ok) {
      viewError = result.error;
      return;
    }

    LazyViewDemo = result.value;
  };
</script>

<svelte:head>
  <title>Svelte 5 + Bun 懒加载示例</title>
</svelte:head>

<div class="app-shell">
  <section class="hero">
    <p class="eyebrow">Svelte 5 + Bun</p>
    <h1>无 Vite, 但有真实 lazy chunk</h1>
    <img class="hero-mark" src="/assets/panel-mark.svg" alt="Builder assets demo" />
    <p class="summary">这个页面同时演示按钮触发懒加载与子视图懒加载, 方便直接观察代码分割产物。</p>
  </section>

  <section class="panel counter-panel">
    <div>
      <h2>同步首屏</h2>
      <p>首屏逻辑仍保持简单同步, 用来对比下面两个懒加载入口。</p>
    </div>
    <button class="primary" onclick={increment}>点击 {count} 次</button>
  </section>

  <section class="grid">
    <article class="panel">
      <div class="panel-header">
        <div>
          <p class="label">示例 A</p>
          <h2>按钮触发懒加载</h2>
        </div>
        <button class="secondary" onclick={loadButtonDemo} disabled={isButtonLoading || !!LazyButtonDemo}>
          {#if isButtonLoading}
            正在加载...
          {:else if LazyButtonDemo}
            已完成
          {:else}
            点击加载
          {/if}
        </button>
      </div>

      <p class="hint">只有在用户点击后, 才会下载这个交互说明组件。</p>

      {#if buttonError}
        <p class="error">加载失败: {buttonError}</p>
      {/if}

      {#if LazyButtonDemo}
        <div class="lazy-slot">
          <LazyButtonDemo />
        </div>
      {/if}
    </article>

    <article class="panel">
      <div class="panel-header">
        <div>
          <p class="label">示例 B</p>
          <h2>子视图懒加载</h2>
        </div>
        <div class="tabs">
          <button class:active={activeView === "home"} onclick={showHome}>首页</button>
          <button class:active={activeView === "details"} onclick={showDetails}>详情</button>
        </div>
      </div>

      {#if activeView === "home"}
        <div class="view-card">
          <h3>同步首页视图</h3>
          <p>默认只展示同步内容, 不额外请求详情面板代码。</p>
        </div>
      {:else if isViewLoading}
        <div class="view-card">
          <h3>正在进入详情视图</h3>
          <p>这个阶段会触发一个独立的动态 import。</p>
        </div>
      {:else if viewError}
        <p class="error">加载失败: {viewError}</p>
      {:else if LazyViewDemo}
        <div class="lazy-slot">
          <LazyViewDemo />
        </div>
      {/if}
    </article>
  </section>
</div>

<style>
  :global(body) {
    margin: 0;
    font-family: "Helvetica Neue", "PingFang SC", "Noto Sans SC", sans-serif;
    background:
      radial-gradient(circle at top left, rgba(245, 177, 52, 0.2), transparent 28%),
      linear-gradient(180deg, #fffdf7 0%, #f5f0e3 100%);
    color: #1f2430;
  }

  .app-shell {
    max-width: 980px;
    margin: 0 auto;
    padding: 48px 20px 72px;
  }

  .hero {
    margin-bottom: 28px;
  }

  .eyebrow,
  .label {
    margin: 0 0 8px;
    color: #8a5c14;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  .hero h1 {
    font-size: clamp(32px, 5vw, 54px);
    line-height: 1;
    margin-bottom: 12px;
  }

  .summary {
    max-width: 720px;
    font-size: 18px;
    line-height: 1.6;
    color: #4a4f5d;
  }

  .hero-mark {
    display: block;
    width: min(280px, 100%);
    margin: 18px 0 16px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 18px;
  }

  .panel {
    background: rgba(255, 255, 255, 0.78);
    border: 1px solid rgba(31, 36, 48, 0.08);
    border-radius: 24px;
    box-shadow: 0 18px 40px rgba(31, 36, 48, 0.08);
    padding: 24px;
    backdrop-filter: blur(10px);
  }

  .counter-panel {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    margin-bottom: 18px;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 14px;
  }

  .panel h2 {
    margin-bottom: 10px;
    font-size: 24px;
  }

  .hint {
    color: #5b6170;
    line-height: 1.6;
    margin-bottom: 16px;
  }

  .primary,
  .secondary,
  .tabs button {
    border: 0;
    border-radius: 999px;
    cursor: pointer;
    transition: transform 160ms ease, opacity 160ms ease, background 160ms ease;
  }

  .primary,
  .secondary {
    padding: 12px 18px;
    font-size: 15px;
    font-weight: 700;
  }

  .primary {
    background: linear-gradient(135deg, #ff9f1c 0%, #ff6b35 100%);
    color: #fff;
  }

  .secondary {
    background: #1f2430;
    color: #fff8ea;
  }

  .primary:hover,
  .secondary:hover,
  .tabs button:hover {
    transform: translateY(-1px);
  }

  .primary:disabled,
  .secondary:disabled {
    opacity: 0.65;
    cursor: default;
    transform: none;
  }

  .tabs {
    display: inline-flex;
    padding: 4px;
    background: #f1e7cf;
    border-radius: 999px;
  }

  .tabs button {
    background: transparent;
    color: #6e5730;
    padding: 9px 14px;
    font-weight: 700;
  }

  .tabs button.active {
    background: #fffdf7;
    color: #1f2430;
  }

  .lazy-slot {
    margin-top: 14px;
  }

  .view-card {
    background: rgba(241, 231, 207, 0.48);
    border-radius: 18px;
    padding: 18px;
  }

  .view-card h3 {
    margin-bottom: 8px;
  }

  .view-card p,
  .panel p {
    line-height: 1.6;
  }

  .error {
    color: #9f1f1f;
    font-weight: 600;
  }

  @media (max-width: 700px) {
    .counter-panel,
    .panel-header {
      flex-direction: column;
      align-items: stretch;
    }

    .tabs {
      width: fit-content;
    }
  }
</style>
