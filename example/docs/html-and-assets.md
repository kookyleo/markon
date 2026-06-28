# HTML and Assets

This page verifies local asset allowlisting, raw HTML passthrough, and simple data links.

<link rel="stylesheet" href="../assets/workspace.css">

![Sample architecture](../assets/sample-architecture.svg)

<div class="e2e-panel" data-testid="asset-panel">
  <h2>Raw HTML panel target</h2>
  <p>This panel should use styles from <code>../assets/workspace.css</code>.</p>
  <p>The local SVG above should load from the workspace asset allowlist.</p>
</div>

## Local Data Link

The sample metrics file is available at [sample-metrics.csv](../data/sample-metrics.csv).

## HTML Table

<table class="e2e-table">
  <thead>
    <tr>
      <th>Signal</th>
      <th>Expected value</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Asset CSS</td>
      <td>Loaded</td>
    </tr>
    <tr>
      <td>Local SVG</td>
      <td>Visible</td>
    </tr>
  </tbody>
</table>

