// ShareItemMenu tests (share-manage-page task 004).
//
// The per-card kebab menu on the manage page. It must behave like a real
// menu: labeled trigger with aria-expanded, Escape closes and returns
// focus, outside mousedown closes, arrow keys move between items, and the
// last-item guard disables Remove while showing the hint. The panel is
// portaled (the thumbnail wrapper clips overflow), so these tests prove
// the portal lands in the document and stays queryable.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { ShareItemMenu } from "./share-item-menu";
import { renderWithProviders } from "../test/utils";

const HINT = "A share needs at least one item — revoke the share instead.";

function renderMenu(
  props: Partial<Parameters<typeof ShareItemMenu>[0]> = {},
) {
  const onRemove = vi.fn();
  renderWithProviders(
    <ShareItemMenu
      videoName="Alpha clip"
      videoHref="/watch/v1"
      canRemove={true}
      onRemove={onRemove}
      {...props}
    />,
  );
  return { onRemove };
}

describe("ShareItemMenu", () => {
  it("opens a menu with Open and Remove from share on trigger click", () => {
    renderMenu();
    const trigger = screen.getByRole("button", {
      name: /more actions for alpha clip/i,
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("menuitem", { name: /open/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /remove from share/i }),
    ).toBeInTheDocument();
    void menu;
  });

  it("Escape closes the menu and returns focus to the trigger", () => {
    renderMenu();
    const trigger = screen.getByRole("button", {
      name: /more actions for alpha clip/i,
    });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");

    fireEvent.keyDown(menu, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on mousedown outside the menu", () => {
    renderMenu();
    fireEvent.click(
      screen.getByRole("button", { name: /more actions for alpha clip/i }),
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("moves focus between menu items with arrow keys", () => {
    renderMenu();
    fireEvent.click(
      screen.getByRole("button", { name: /more actions for alpha clip/i }),
    );
    const items = screen.getAllByRole("menuitem");
    items[0].focus();
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(items[0]).toHaveFocus();
  });

  it("disables Remove and shows the guard hint when removal is not allowed", () => {
    renderMenu({ canRemove: false, removeHint: HINT });
    fireEvent.click(
      screen.getByRole("button", { name: /more actions for alpha clip/i }),
    );

    const remove = screen.getByRole("menuitem", {
      name: /remove from share/i,
    });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it("activating Remove invokes onRemove and closes the menu", () => {
    const { onRemove } = renderMenu();
    fireEvent.click(
      screen.getByRole("button", { name: /more actions for alpha clip/i }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: /remove from share/i }),
    );

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("links Open to the video's watch page", () => {
    renderMenu();
    fireEvent.click(
      screen.getByRole("button", { name: /more actions for alpha clip/i }),
    );

    expect(screen.getByRole("menuitem", { name: /open/i })).toHaveAttribute(
      "href",
      "/watch/v1",
    );
  });
});
