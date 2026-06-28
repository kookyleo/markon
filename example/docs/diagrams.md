# Diagram Gallery

This page exercises Supramark diagram rendering and unsupported diagram source fallback behavior. It also includes the search token `MARKON_E2E_DIAGRAM_SEARCH_TOKEN`.

## Mermaid Flowchart

Mermaid flowchart target.

```mermaid title="Release flow" wide
flowchart TD
    A[Write Markdown] --> B[Render Preview]
    B --> C{Review}
    C -->|Pass| D[Publish]
    C -->|Fail| A
```

## Mermaid Sequence Diagram

```mermaid
sequenceDiagram
    participant User
    participant GUI
    participant Server
    User->>GUI: Open workspace
    GUI->>Server: Request directory data
    Server-->>GUI: Return files and git status
    GUI-->>User: Show workspace panel
```

## Mermaid Class Diagram

```mermaid
classDiagram
    class Workspace {
      +string id
      +string root
      +open()
      +status()
    }
    class MarkdownFile {
      +string path
      +render()
    }
    Workspace "1" --> "*" MarkdownFile
```

## Mermaid State Diagram

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Review
    Review --> Published
    Review --> Draft
    Published --> [*]
```

## Mermaid Entity Relationship Diagram

```mermaid
erDiagram
    WORKSPACE ||--o{ FILE : contains
    FILE ||--o{ ANNOTATION : has
    FILE {
      string path
      string title
    }
    ANNOTATION {
      string id
      string note
    }
```

## Mermaid User Journey

```mermaid
journey
    title Workspace review
    section Open
      Choose workspace: 5: User
      Scan git status: 4: User
    section Review
      Open visual diff: 4: User
      Save Markdown edit: 5: User
```

## Mermaid Gantt Chart

```mermaid
gantt
    title Documentation release
    dateFormat  YYYY-MM-DD
    section Draft
    Outline      :a1, 2026-06-01, 2d
    Write        :a2, after a1, 4d
    section Review
    Visual diff  :a3, after a2, 2d
    Publish      :a4, after a3, 1d
```

## Mermaid Pie Chart

```mermaid
pie title Coverage by area
    "Rendering" : 35
    "Workspace" : 30
    "Search" : 20
    "Chat" : 15
```

## Mermaid Mindmap

```mermaid
mindmap
  root((Markon))
    Markdown
      Rendered diff
      Source fallback
    Workspace
      Git status
      File browser
    Review
      Notes
      Viewed tracking
```

## Mermaid Timeline

```mermaid
timeline
    title Markon sample timeline
    Draft : Create notes : Add diagrams
    Review : Compare changes : Save edits
    Publish : Open final page
```

## Mermaid Git Graph

```mermaid
gitGraph
    commit id: "baseline"
    branch docs
    checkout docs
    commit id: "add-diagrams"
    checkout main
    merge docs
```

## Rendered Diagram: Graphviz DOT

Graphviz DOT target.

```dot
digraph Workspace {
  Readme -> Diagrams;
  Diagrams -> DiffTarget;
}
```

## Rendered Diagram: Graphviz Alias

Graphviz alias target.

```graphviz
digraph AliasCoverage {
  Engine -> Registry;
  Registry -> Renderer;
}
```

## Rendered Diagram: PlantUML

PlantUML sequence target.

```plantuml
@startuml
actor User
User -> Markon: open workspace
Markon --> User: rendered Markdown
@enduml
```

## Rendered Diagram: D2

D2 diagram target.

```d2
workspace: Workspace
markdown: Markdown files
review: Visual review
workspace -> markdown
markdown -> review
```

## Rendered Diagram: Vega-Lite

Vega-Lite chart target.

```vega-lite
{
  "data": {
    "values": [
      {"area": "Rendering", "score": 35},
      {"area": "Workspace", "score": 30},
      {"area": "Search", "score": 20}
    ]
  },
  "mark": "bar",
  "encoding": {
    "x": {"field": "area", "type": "nominal"},
    "y": {"field": "score", "type": "quantitative"}
  }
}
```

## Rendered Diagram: Vega Alias

Vega alias line chart target.

```vega
{
  "title": {"text": "Vega alias trend"},
  "data": {
    "values": [
      {"stage": "Draft", "score": 12},
      {"stage": "Review", "score": 28},
      {"stage": "Publish", "score": 34}
    ]
  },
  "mark": "line",
  "encoding": {
    "x": {"field": "stage", "type": "nominal"},
    "y": {"field": "score", "type": "quantitative"}
  }
}
```

## Rendered Diagram: Chart Alias

Chart alias scatter target. This alias uses the Supramark Vega-Lite renderer.

```chart
{
  "title": "Chart alias scatter",
  "data": {
    "values": [
      {"item": "A", "score": 8},
      {"item": "B", "score": 14},
      {"item": "C", "score": 22}
    ]
  },
  "mark": "point",
  "encoding": {
    "x": {"field": "item", "type": "nominal"},
    "y": {"field": "score", "type": "quantitative"}
  }
}
```

## Rendered Diagram: ECharts

ECharts chart target.

```echarts
{
  "xAxis": {"type": "category", "data": ["Render", "Search", "Edit"]},
  "yAxis": {"type": "value"},
  "series": [{"type": "line", "data": [35, 20, 25]}]
}
```

## Rendered Diagram: ECharts Pie

ECharts pie chart target.

```echarts
{
  "title": {"text": "Workspace attention"},
  "series": [{
    "type": "pie",
    "data": [
      {"name": "Writing", "value": 42},
      {"name": "Review", "value": 33},
      {"name": "Search", "value": 25}
    ]
  }]
}
```

## Rendered Diagram: Chart.js

Chart.js doughnut chart target.

```chartjs
{
  "type": "doughnut",
  "data": {
    "labels": ["Markdown", "Workspace", "Review"],
    "datasets": [{"data": [40, 35, 25]}]
  }
}
```

## Rendered Diagram: Chart.js Alias

Chart.js alias line chart target.

```chart.js
{
  "type": "line",
  "data": {
    "labels": ["Draft", "Review", "Launch"],
    "datasets": [{
      "label": "Readiness",
      "data": [72, 91, 100]
    }]
  },
  "options": {
    "plugins": {
      "title": {
        "text": "Release readiness"
      }
    }
  }
}
```

## Unsupported Diagram Fallback: Plotly

This block intentionally remains a labeled source fallback because Plotly is not registered in the Rust Supramark diagram registry.

```plotly
{
  "data": [{"type": "bar", "x": ["A", "B"], "y": [1, 2]}]
}
```
