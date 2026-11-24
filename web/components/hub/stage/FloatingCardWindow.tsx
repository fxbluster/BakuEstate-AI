"use client";

import React, { useEffect } from "react";
import { GripHorizontal, Maximize2, Minimize2, X } from "lucide-react";
import { useFloatingWindow, type WindowPosition } from "./useFloatingWindow";

export interface FloatingCardWindowProps {
  id: string;
  title: string;
  badge?: React.ReactNode;
  icon?: React.ReactNode;
  onClose?: () => void;
  onFocus?: () => void;
  zIndex?: number;
  isFocused?: boolean;
  children: React.ReactNode;
  initialOffsetIndex?: number;
  initialPosition?: WindowPosition;
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  className?: string;
}

export function FloatingCardWindow({
  id,
  title,
  badge,
  icon,
  onClose,
  onFocus,
  zIndex,
  isFocused,
  children,
  initialOffsetIndex = 0,
  initialPosition,
  defaultWidth = 620,
  defaultHeight = 520,
  minWidth = 360,
  minHeight = 320,
  maxWidth = 1400,
  maxHeight = 1000,
  className = "",
}: FloatingCardWindowProps) {
  const {
    position,
    size,
    isMaximized,
    isDragging,
    isResizing,
    isMobile,
    toggleMaximize,
    handleDragPointerDown,
    handleResizePointerDown,
    handlePointerMove,
    handlePointerUp,
  } = useFloatingWindow({
    initialOffsetIndex,
    initialPosition,
    defaultWidth,
    defaultHeight,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
  });

  // Global Escape key listener to close the focused window
  useEffect(() => {
    if (isFocused === false) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFocused, onClose]);

  // Global pointer move and up listeners when active dragging or resizing
  useEffect(() => {
    if (!isDragging && !isResizing) return;

    const onMove = (e: PointerEvent) => {
      handlePointerMove(e as unknown as React.PointerEvent);
    };
    const onUp = (e: PointerEvent) => {
      handlePointerUp(e as unknown as React.PointerEvent);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [isDragging, isResizing, handlePointerMove, handlePointerUp]);

  // Mobile Bottom-Sheet fallback (<768px)
  if (isMobile) {
    return (
      <div
        id={`floating-card-${id}`}
        onPointerDown={() => onFocus?.()}
        className={`fixed inset-x-2.5 bottom-0 max-h-[85vh] rounded-t-2xl z-50 bg-obsidian-950/95 border border-amber-500/30 flex flex-col shadow-2xl overflow-hidden backdrop-blur-xl pointer-events-auto ${className}`}
      >
        <div className="flex items-center justify-between px-3.5 py-2.5 bg-obsidian-900/90 border-b border-slate-800/80 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {icon && <div className="shrink-0">{icon}</div>}
            <span className="text-xs font-semibold text-slate-200 truncate">{title}</span>
            {badge && <div className="shrink-0">{badge}</div>}
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Bağla"
              className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      </div>
    );
  }

  // Desktop Floating Card Window
  return (
    <div
      id={`floating-card-${id}`}
      onPointerDown={() => onFocus?.()}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
        width: `${size.width}px`,
        height: `${size.height}px`,
        zIndex: zIndex ?? (isFocused ? 60 : 40),
      }}
      className={`fixed top-0 left-0 flex flex-col bg-obsidian-950/95 backdrop-blur-xl rounded-2xl border shadow-2xl overflow-hidden transition-[box-shadow,border-color] duration-200 pointer-events-auto ${
        isFocused
          ? "border-amber-500/40 ring-1 ring-amber-500/30 shadow-[0_16px_48px_rgba(0,0,0,0.85)]"
          : "border-slate-800/80 shadow-xl hover:border-slate-700/90"
      } ${className}`}
    >
      {/* Chrome Header Bar */}
      <div
        onPointerDown={handleDragPointerDown}
        onDoubleClick={toggleMaximize}
        className={`flex items-center justify-between px-3.5 py-2.5 bg-obsidian-900/90 border-b border-slate-800/80 shrink-0 select-none ${
          isMaximized ? "cursor-default" : "cursor-grab active:cursor-grabbing"
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="text-slate-500 hover:text-slate-400 transition-colors">
            <GripHorizontal className="w-4 h-4" />
          </div>
          {icon && <div className="shrink-0">{icon}</div>}
          <span className="text-xs font-semibold text-slate-200 truncate">{title}</span>
          {badge && <div className="shrink-0">{badge}</div>}
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-2">
          <button
            type="button"
            onClick={toggleMaximize}
            title={isMaximized ? "Kiçilt" : "Böyüt"}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 transition-colors"
          >
            {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Bağla"
              className="p-1 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Card Content (isolated from pointer interception during drag) */}
      <div
        className={`flex-1 min-h-0 overflow-y-auto ${
          isDragging || isResizing ? "pointer-events-none select-none" : ""
        }`}
      >
        {children}
      </div>

      {/* Resize Handles */}
      {!isMaximized && (
        <>
          <div
            onPointerDown={(e) => handleResizePointerDown(e, "se")}
            className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize flex items-end justify-end p-0.5 z-20 group"
            title="Ölçünü dəyiş"
          >
            <div className="w-2 h-2 border-r-2 border-b-2 border-slate-600 group-hover:border-amber-400 transition-colors" />
          </div>
          <div
            onPointerDown={(e) => handleResizePointerDown(e, "e")}
            className="absolute top-0 right-0 w-1.5 h-full cursor-e-resize z-10"
          />
          <div
            onPointerDown={(e) => handleResizePointerDown(e, "s")}
            className="absolute bottom-0 left-0 w-full h-1.5 cursor-s-resize z-10"
          />
        </>
      )}
    </div>
  );
}
