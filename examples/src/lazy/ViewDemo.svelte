<script>
  const highlights = [
    "切换到详情页时才拉取",
    "路由或 tab 切分都适用",
    "更适合信息密度较高的次级界面",
  ];
</script>

<div class="view-card">
  <h3>子视图延迟装配</h3>
  <p>只有当用户真的进入详情视图时, 这一块代码才参与下载与执行。</p>

  <div class="chips">
    {#each highlights as item}
      <span>{item}</span>
    {/each}
  </div>
</div>

<style>
  .view-card {
    background: linear-gradient(135deg, #fff7e5 0%, #f5dcae 100%);
    border: 1px solid rgba(138, 92, 20, 0.15);
    border-radius: 20px;
    padding: 18px;
  }

  h3 {
    margin: 0 0 8px;
    font-size: 22px;
    color: #2b2f39;
  }

  p {
    margin: 0 0 16px;
    color: #4a4f5d;
    line-height: 1.6;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  span {
    background: rgba(255, 253, 247, 0.86);
    border-radius: 999px;
    color: #6f541e;
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
  }
</style>
