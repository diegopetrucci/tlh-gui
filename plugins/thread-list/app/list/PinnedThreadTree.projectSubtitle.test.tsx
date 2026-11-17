// @vitest-environment jsdom

import { cleanup, screen } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { makeSidebarThread } from "../model/fixtures.js";
import type {
  EnvironmentThreadGroup,
  ProjectThreadNode,
} from "../model/project-thread-groups.js";
import { SidebarProjectsContext } from "../model/use-sidebar-data.js";
import { SidebarRenameProvider } from "../rows/SidebarInlineRename.js";

installTestPluginRuntime();
const { ThreadRowNavigationProvider } =
  await import("../rows/threadRowNavigation.js");
const { ThreadSelectionProvider } =
  await import("../selection/threadSelection.js");
const { PinnedThreadTree } = await import("./PinnedThreadTree.js");

const PARENT_EXTRA_VAR = "--bb-sidebar-sticky-parent-extra";

const PROJECTS = [
  { id: "proj_a", name: "Alpha" },
  { id: "proj_b", name: "Beta" },
  { id: "proj_c", name: "Gamma" },
].map((project) => ({
  ...project,
  isPersonal: false,
  href: `/projects/${project.id}`,
  settingsHref: `/projects/${project.id}/settings`,
}));

const STATS = { childCount: 0, hiddenThreads: [] };

function pinned(
  id: string,
  projectId: string,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return makeSidebarThread({
    id,
    projectId,
    title: `Title ${id}`,
    titleFallback: `Title ${id}`,
    pinnedAt: 1,
    ...overrides,
  });
}

function node(
  thread: PluginSidebarThread,
  children: ProjectThreadNode[] = [],
  depth = 0,
): ProjectThreadNode {
  return {
    thread,
    depth,
    children: children.map((child) => ({ kind: "thread", node: child })),
    stats: { ...STATS, childCount: children.length },
  };
}

function Slot({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProjectsContext.Provider value={PROJECTS}>
      <TooltipProvider>
        <ThreadRowNavigationProvider>
          <ThreadSelectionProvider activeThreadId={null}>
            <SidebarRenameProvider>{children}</SidebarRenameProvider>
          </ThreadSelectionProvider>
        </ThreadRowNavigationProvider>
      </TooltipProvider>
    </SidebarProjectsContext.Provider>
  );
}

function renderTree({
  rootItems,
  rootNodes,
  threads,
}: {
  rootItems: ProjectThreadNode[] | EnvironmentThreadGroup[];
  rootNodes: ProjectThreadNode[];
  threads: PluginSidebarThread[];
}) {
  const items =
    rootItems.length > 0 && "environmentId" in rootItems[0]
      ? (rootItems as EnvironmentThreadGroup[]).map((group) => ({
          kind: "environment" as const,
          group,
        }))
      : (rootItems as ProjectThreadNode[]).map((n) => ({
          kind: "thread" as const,
          node: n,
        }));
  return renderSlot(
    { component: Slot },
    {
      children: (
        <PinnedThreadTree
          rootItems={items}
          rootNodes={rootNodes}
          collapsedThreadIds={new Set()}
          collapsedEnvironmentIds={new Set()}
          onToggleThreadCollapsed={vi.fn()}
          onToggleEnvironmentCollapsed={vi.fn()}
        />
      ),
    },
    { sidebarThreads: { threads, projects: PROJECTS } },
  );
}

function subtitles(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll("[data-sidebar-thread-project-subtitle]"),
  ].map((element) => element.textContent ?? "");
}

function rowFor(title: string): HTMLElement {
  const row = screen.getByText(title).closest("[data-sidebar-rename-row]");
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${title}`);
  return row;
}

describe("PinnedThreadTree project subtitle", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the project on pinned roots only and offsets sticky descendants", () => {
    const child = pinned("child", "proj_b", { parentThreadId: "root" });
    const root = node(pinned("root", "proj_a"), [node(child, [], 1)]);
    const other = node(pinned("other", "proj_c"));
    const { container } = renderTree({
      rootItems: [root, other],
      rootNodes: [root, other],
      threads: [root.thread, child, other.thread],
    });

    expect(subtitles(container)).toEqual(["Alpha", "Gamma"]);
    expect(
      rowFor("Title child").hasAttribute("data-sidebar-project-subtitle"),
    ).toBe(false);
    expect(
      rowFor("Title root").hasAttribute("data-sidebar-project-subtitle"),
    ).toBe(true);
    expect(rowFor("Title root").closest(`[style*="${PARENT_EXTRA_VAR}"]`)).toBe(
      null,
    );
    expect(
      rowFor("Title child").closest(`[style*="${PARENT_EXTRA_VAR}"]`),
    ).not.toBeNull();
  });

  it("shows the project on environment-grouped roots but not their descendants", () => {
    const child = pinned("child", "proj_c", { parentThreadId: "first" });
    const first = node(pinned("first", "proj_a"), [node(child, [], 1)]);
    const second = node(pinned("second", "proj_b"));
    const group: EnvironmentThreadGroup = {
      environmentId: "env_1",
      environmentProviderId: null,
      nodes: [first, second],
      stats: { ...STATS, childCount: 2 },
    };
    const { container } = renderTree({
      rootItems: [group],
      rootNodes: [first, second],
      threads: [first.thread, child, second.thread],
    });

    expect(subtitles(container)).toEqual(["Alpha", "Beta"]);
    expect(
      rowFor("Title child").hasAttribute("data-sidebar-project-subtitle"),
    ).toBe(false);
  });
});
