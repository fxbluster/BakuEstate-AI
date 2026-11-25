import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FloatingCardWindow } from "@/components/hub/stage/FloatingCardWindow";

declare module "vitest" {
  interface Assertion {
    toBeInTheDocument(): void;
  }
}

// Provide toBeInTheDocument matcher if not registered by default
expect.extend({
  toBeInTheDocument(received) {
    const pass = received !== null && received !== undefined && (received.ownerDocument?.contains(received) ?? true);
    return {
      pass,
      message: () => `expected element ${pass ? "not " : ""}to be in document`,
    };
  },
});

describe("FloatingCardWindow", () => {
  it("renders chrome title, badge, and children", () => {
    const onClose = vi.fn();
    render(
      <FloatingCardWindow
        id="test-card-1"
        title="Video #6588858"
        badge={<span data-testid="test-badge">Hazır</span>}
        onClose={onClose}
      >
        <div data-testid="card-content">Inner Content</div>
      </FloatingCardWindow>
    );

    expect(screen.getByText("Video #6588858")).toBeInTheDocument();
    expect(screen.getByTestId("test-badge")).toBeInTheDocument();
    expect(screen.getByTestId("card-content")).toBeInTheDocument();

    const closeBtn = screen.getByTitle("Bağla");
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("toggles maximize state when clicking the maximize button", () => {
    render(
      <FloatingCardWindow id="test-card-2" title="Analytics Window">
        <div>Body</div>
      </FloatingCardWindow>
    );

    const maxBtn = screen.getByTitle("Böyüt");
    fireEvent.click(maxBtn);

    // Now button title should indicate restore/minimize
    expect(screen.getByTitle("Kiçilt")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Kiçilt"));
    expect(screen.getByTitle("Böyüt")).toBeInTheDocument();
  });

  it("dismisses the window on Escape key press when focused", () => {
    const onClose = vi.fn();
    render(
      <FloatingCardWindow id="test-card-3" title="Esc Window" onClose={onClose} isFocused={true}>
        <div>Dismissible Content</div>
      </FloatingCardWindow>
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onFocus when clicking anywhere inside the window", () => {
    const onFocus = vi.fn();
    render(
      <FloatingCardWindow id="test-card-4" title="Focus Window" onFocus={onFocus}>
        <div data-testid="focusable-content">Focus Content</div>
      </FloatingCardWindow>
    );

    fireEvent.pointerDown(screen.getByTestId("focusable-content"));
    expect(onFocus).toHaveBeenCalled();
  });
});
