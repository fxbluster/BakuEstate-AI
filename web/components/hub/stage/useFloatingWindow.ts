"use client";

import { useState, useRef, useEffect, useCallback } from "react";

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface FloatingWindowOptions {
  initialOffsetIndex?: number;
  initialPosition?: WindowPosition;
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export function useFloatingWindow(options: FloatingWindowOptions = {}) {
  const {
    initialOffsetIndex = 0,
    defaultWidth = 620,
    defaultHeight = 520,
    minWidth = 360,
    minHeight = 320,
    maxWidth = 1400,
    maxHeight = 1000,
  } = options;

  const initialX = options.initialPosition?.x ?? 28 + initialOffsetIndex * 32;
  const initialY = options.initialPosition?.y ?? 68 + initialOffsetIndex * 32;

  const [position, setPosition] = useState<WindowPosition>({
    x: initialX,
    y: initialY,
  });

  const [size, setSize] = useState<WindowSize>({
    width: defaultWidth,
    height: defaultHeight,
  });

  const [isMaximized, setIsMaximized] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window !== "undefined") {
      return window.innerWidth < 768;
    }
    return false;
  });

  const positionRef = useRef(position);
  positionRef.current = position;

  const sizeRef = useRef(size);
  sizeRef.current = size;

  const isDraggingRef = useRef(isDragging);
  isDraggingRef.current = isDragging;

  const isResizingRef = useRef(isResizing);
  isResizingRef.current = isResizing;

  const isMaximizedRef = useRef(isMaximized);
  isMaximizedRef.current = isMaximized;

  const prevBoundsRef = useRef<{ position: WindowPosition; size: WindowSize } | null>(null);

  const dragStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    posX: number;
    posY: number;
  }>({ pointerX: 0, pointerY: 0, posX: 0, posY: 0 });

  const resizeStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    width: number;
    height: number;
    direction: "se" | "e" | "s";
  }>({ pointerX: 0, pointerY: 0, width: 0, height: 0, direction: "se" });

  // Handle window resizing and boundary re-clamping
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleWindowResize = () => {
      const winW = window.innerWidth;
      const winH = window.innerHeight;

      setIsMobile(winW < 768);

      if (isMaximizedRef.current) {
        setPosition({ x: 12, y: 12 });
        setSize({
          width: Math.max(minWidth, winW - 24),
          height: Math.max(minHeight, winH - 24),
        });
      } else {
        const curSize = sizeRef.current;
        const curPos = positionRef.current;

        const maxX = Math.max(10, winW - curSize.width - 10);
        const maxY = Math.max(10, winH - curSize.height - 10);

        const clampedX = Math.max(10, Math.min(curPos.x, maxX));
        const clampedY = Math.max(10, Math.min(curPos.y, maxY));

        if (clampedX !== curPos.x || clampedY !== curPos.y) {
          setPosition({ x: clampedX, y: clampedY });
        }
      }
    };

    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [minWidth, minHeight]);

  const toggleMaximize = useCallback(() => {
    setIsMaximized((prev) => {
      if (!prev) {
        // Maximizing: store previous bounds
        prevBoundsRef.current = {
          position: positionRef.current,
          size: sizeRef.current,
        };
        const winW = typeof window !== "undefined" ? window.innerWidth : 1200;
        const winH = typeof window !== "undefined" ? window.innerHeight : 800;
        setPosition({ x: 12, y: 12 });
        setSize({
          width: Math.max(minWidth, winW - 24),
          height: Math.max(minHeight, winH - 24),
        });
        return true;
      } else {
        // Restoring previous bounds
        if (prevBoundsRef.current) {
          setPosition(prevBoundsRef.current.position);
          setSize(prevBoundsRef.current.size);
        } else {
          setPosition({ x: initialX, y: initialY });
          setSize({ width: defaultWidth, height: defaultHeight });
        }
        return false;
      }
    });
  }, [initialX, initialY, defaultWidth, defaultHeight, minWidth, minHeight]);

  const handleDragPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (isMaximizedRef.current) return;
      if (e.button !== undefined && e.button !== 0) return; // Primary button only

      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        // Ignore if pointer capture fails
      }

      dragStartRef.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        posX: positionRef.current.x,
        posY: positionRef.current.y,
      };

      setIsDragging(true);
    },
    []
  );

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent, direction: "se" | "e" | "s" = "se") => {
      if (isMaximizedRef.current) return;
      if (e.button !== undefined && e.button !== 0) return;

      e.stopPropagation?.();

      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        // Ignore if pointer capture fails
      }

      resizeStartRef.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        width: sizeRef.current.width,
        height: sizeRef.current.height,
        direction,
      };

      setIsResizing(true);
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (isDraggingRef.current) {
        const dx = e.clientX - dragStartRef.current.pointerX;
        const dy = e.clientY - dragStartRef.current.pointerY;
        const targetX = dragStartRef.current.posX + dx;
        const targetY = dragStartRef.current.posY + dy;

        const winW = typeof window !== "undefined" ? window.innerWidth : 1440;
        const winH = typeof window !== "undefined" ? window.innerHeight : 900;

        const curSize = sizeRef.current;
        const clampedX = Math.max(10, Math.min(targetX, winW - curSize.width - 10));
        const clampedY = Math.max(10, Math.min(targetY, winH - curSize.height - 10));

        setPosition({ x: clampedX, y: clampedY });
      } else if (isResizingRef.current) {
        const dx = e.clientX - resizeStartRef.current.pointerX;
        const dy = e.clientY - resizeStartRef.current.pointerY;

        const winW = typeof window !== "undefined" ? window.innerWidth : 1440;
        const winH = typeof window !== "undefined" ? window.innerHeight : 900;

        const curPos = positionRef.current;
        // Clamp resize width against window.innerWidth - pos.x - 10
        const maxAvailableW = Math.max(minWidth, winW - curPos.x - 10);
        const maxAvailableH = Math.max(minHeight, winH - curPos.y - 10);

        const allowedMaxW = Math.min(maxWidth, maxAvailableW);
        const allowedMaxH = Math.min(maxHeight, maxAvailableH);

        const direction = resizeStartRef.current.direction;
        let newW = sizeRef.current.width;
        let newH = sizeRef.current.height;

        if (direction !== "s") {
          newW = Math.max(minWidth, Math.min(allowedMaxW, resizeStartRef.current.width + dx));
        }
        if (direction !== "e") {
          newH = Math.max(minHeight, Math.min(allowedMaxH, resizeStartRef.current.height + dy));
        }

        setSize({ width: newW, height: newH });
      }
    },
    [minWidth, minHeight, maxWidth, maxHeight]
  );

  const handlePointerUp = useCallback((e?: React.PointerEvent) => {
    if (e && e.currentTarget) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      } catch {
        // Ignore
      }
    }
    setIsDragging(false);
    setIsResizing(false);
  }, []);

  return {
    position,
    size,
    isMaximized,
    isDragging,
    isResizing,
    isMobile,
    setPosition,
    setSize,
    toggleMaximize,
    handleDragPointerDown,
    handleResizePointerDown,
    handlePointerMove,
    handlePointerUp,
  };
}
