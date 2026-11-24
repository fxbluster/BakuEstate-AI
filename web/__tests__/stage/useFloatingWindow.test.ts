import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFloatingWindow } from "@/components/hub/stage/useFloatingWindow";

describe("useFloatingWindow", () => {
  beforeEach(() => {
    // Set standard desktop viewport
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { writable: true, configurable: true, value: 900 });
  });

  it("initializes with staggered offset by default", () => {
    const { result } = renderHook(() => useFloatingWindow({ initialOffsetIndex: 2 }));
    expect(result.current.position.x).toBe(28 + 2 * 32);
    expect(result.current.position.y).toBe(68 + 2 * 32);
    expect(result.current.size.width).toBe(620);
    expect(result.current.size.height).toBe(520);
    expect(result.current.isMaximized).toBe(false);
    expect(result.current.isMobile).toBe(false);
  });

  it("toggles maximize and restores previous bounds", () => {
    const { result } = renderHook(() => useFloatingWindow({ defaultWidth: 500, defaultHeight: 400 }));
    act(() => {
      result.current.toggleMaximize();
    });
    expect(result.current.isMaximized).toBe(true);
    expect(result.current.position.x).toBe(12);
    expect(result.current.position.y).toBe(12);

    act(() => {
      result.current.toggleMaximize();
    });
    expect(result.current.isMaximized).toBe(false);
    expect(result.current.size.width).toBe(500);
    expect(result.current.size.height).toBe(400);
  });

  it("detects mobile viewport when screen width < 768px", () => {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 375 });
    const { result } = renderHook(() => useFloatingWindow());
    expect(result.current.isMobile).toBe(true);
  });

  it("re-clamps position within boundaries when window resize occurs", () => {
    const { result } = renderHook(() =>
      useFloatingWindow({ defaultWidth: 600, defaultHeight: 500, initialPosition: { x: 1000, y: 500 } })
    );

    // Simulate window resizing to a smaller screen
    act(() => {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1024 });
      Object.defineProperty(window, "innerHeight", { writable: true, configurable: true, value: 768 });
      window.dispatchEvent(new Event("resize"));
    });

    // x must be clamped <= window.innerWidth - size.width - 10 = 1024 - 600 - 10 = 414
    expect(result.current.position.x).toBeLessThanOrEqual(414);
    // y must be clamped <= window.innerHeight - size.height - 10 = 768 - 500 - 10 = 258
    expect(result.current.position.y).toBeLessThanOrEqual(258);
  });

  it("handles pointer drag and clamps to viewport bounds", () => {
    const { result } = renderHook(() =>
      useFloatingWindow({ defaultWidth: 500, defaultHeight: 400, initialPosition: { x: 50, y: 50 } })
    );

    const mockElement = {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    } as unknown as HTMLElement;

    // Start drag
    act(() => {
      result.current.handleDragPointerDown({
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        currentTarget: mockElement,
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });

    expect(result.current.isDragging).toBe(true);

    // Drag move to valid coordinates
    act(() => {
      result.current.handlePointerMove({
        clientX: 200,
        clientY: 150,
      } as unknown as React.PointerEvent);
    });

    expect(result.current.position.x).toBe(150); // 50 + (200 - 100)
    expect(result.current.position.y).toBe(100); // 50 + (150 - 100)

    // Stop drag
    act(() => {
      result.current.handlePointerUp({
        pointerId: 1,
        currentTarget: mockElement,
      } as unknown as React.PointerEvent);
    });

    expect(result.current.isDragging).toBe(false);
  });

  it("handles pointer resize and clamps against window width and min dimensions", () => {
    const { result } = renderHook(() =>
      useFloatingWindow({
        defaultWidth: 500,
        defaultHeight: 400,
        minWidth: 350,
        minHeight: 300,
        initialPosition: { x: 100, y: 100 },
      })
    );

    const mockElement = {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    } as unknown as HTMLElement;

    // Start resize
    act(() => {
      result.current.handleResizePointerDown({
        clientX: 600,
        clientY: 500,
        pointerId: 2,
        currentTarget: mockElement,
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });

    expect(result.current.isResizing).toBe(true);

    // Expand size
    act(() => {
      result.current.handlePointerMove({
        clientX: 700,
        clientY: 600,
      } as unknown as React.PointerEvent);
    });

    expect(result.current.size.width).toBe(600); // 500 + 100
    expect(result.current.size.height).toBe(500); // 400 + 100

    // Attempt to resize larger than window boundary (window.innerWidth = 1440, pos.x = 100 -> max width = 1440 - 100 - 10 = 1330)
    act(() => {
      result.current.handlePointerMove({
        clientX: 2500,
        clientY: 2000,
      } as unknown as React.PointerEvent);
    });

    expect(result.current.size.width).toBeLessThanOrEqual(1440 - 100 - 10);

    // Stop resize
    act(() => {
      result.current.handlePointerUp({
        pointerId: 2,
        currentTarget: mockElement,
      } as unknown as React.PointerEvent);
    });

    expect(result.current.isResizing).toBe(false);
  });
});
