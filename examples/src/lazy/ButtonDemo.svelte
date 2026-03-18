<script>
  const checks = [
    "点击前不会进入首屏 bundle",
    "触发时才请求独立 chunk",
    "适合低频但交互明确的能力",
  ];
</script>

<div class="card">
  <h3>按钮懒加载成功!!!s</h3>
  <p>这个组件只会在用户主动点击后才下载。</p>

  <ul>
    {#each checks as item}
      <li>{item}</li>
    {/each}
  </ul>
</div>

<style>
  .card {
    background: linear-gradient(180deg, #1f2430 0%, #343b4d 100%);
    border-radius: 20px;
    color: #f7f1e4;
    padding: 18px;
  }

  h3 {
    margin: 0 0 8px;
    font-size: 22px;
  }

  p {
    margin: 0 0 12px;
    color: rgba(247, 241, 228, 0.8);
  }

  ul {
    margin: 0;
    padding-left: 18px;
  }

  li + li {
    margin-top: 8px;
  }
</style>
