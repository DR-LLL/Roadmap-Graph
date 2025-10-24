# Roadmap Graph

**Roadmap Graph** is an Obsidian plugin that visualizes note dependencies as an interactive directed acyclic graph (DAG).  
It provides an overview of project structure, module relationships, and workflow progression directly within your vault.

## Features

- **Hierarchical layout:** nodes without dependencies are displayed at the bottom; dependent nodes appear above.
- **Interactive editing:** add or remove edges between notes directly on the graph.
- **Zoom and pan:** scroll to zoom, drag to move the view.
- **Connection highlighting:** hover over a node to highlight related edges.
- **Tooltips:** node descriptions appear on hover.
- **Custom fields:** support for `label`, `title`, `description`, `color`, and `incoming` fields in the note frontmatter.
- **Visual mode:** edit relationships entirely through the graphical interface.

## Installation

1. Clone the repository or download it manually:
   ```bash
   git clone https://github.com/DR-LLL/roadmap-graph.git
   ```
2. Copy the `roadmap-graph` folder into:
   ```
   <your-vault>/.obsidian/plugins/
   ```
3. Restart Obsidian.
4. Enable the plugin under  
   `Settings → Community Plugins → Installed plugins`.

## Usage

1. Add the following frontmatter to any note you want to include in the graph:
   ```yaml
   ---
roadmap: true
status: in-progress
title: "Complexity Class BPP"
label: "BPP"
description: "Learn the class of problems solvable by a probabilistic Turing machine in polynomial time with an error probability < 1/3."
color: "#b0c4de"
incoming:
  - "Probabilistic Turing Machines"
  - [[Randomized Algorithms]]
  - "Complexity Class P"
---

   ```

2. Repeat this for all related notes.

3. Open the **Command Palette** (`Ctrl/Cmd + P`) and run:  
   **“Open Roadmap (graph)”**.

4. Interact with the graph:
   - Scroll to **zoom**.  
   - Drag with the left mouse button to **pan**.  
   - Hover a node to view its description and highlight connections.  
   - Click a node to open the corresponding note.

## Frontmatter Structure

```yaml
---
roadmap: true
status: in-progress
title: "Full title"
label: "Short label"
description: "Node description"
color: "#ffa500"
incoming:
  - Another Note
  - [[Database]]
---
```

**Notes:**
- `incoming` accepts an array or a comma-separated list:  
  ```yaml
  incoming: ["Database", "User model"]
  # or
  incoming: "Database, User model"
  ```
- `from:` can be used as an alias for `incoming:`.
- Both plain note names and `[[WikiLinks]]` are supported.

## Editing Mode

1. Click **“Edit links”** in the top panel (or use the command palette).  
2. While editing:
   - Click a **source node**, then a **target node** to add a link.  
   - Repeat the same clicks to remove an existing link.  
   - Click an **arrow** to remove that connection directly.  
3. Click **“Edit links”** again to exit editing mode.

## Commands

- **Mark current note as in-progress**  
  Adds or updates the following fields in the note frontmatter:
  ```yaml
  roadmap: true
  status: in-progress
  title:
  label:
  description:
  color:
  incoming:
  ```
  This prepares the note for inclusion in the roadmap graph.


## Recommendations

- The graph assumes a **DAG** structure (no cycles).  
- Only notes with `roadmap: true` and `status: in-progress` are included.  
- Colors can use CSS variables, e.g.:
  ```yaml
  color: "var(--interactive-accent)"
  ```

## Author 

**Author:** [DR-LLL](https://github.com/DR-LLL)  
**Plugin ID:** `roadmap-graph`  
**Version:** 1.0.0  


