import { useCallback, useEffect, useRef, useState } from "react";
import {
  getWorkspaceStoreState,
  navigateWorkspaceRoute,
  setNavigationSurface,
  toggleIntake,
} from "./workspaceStore.js";
import {
  parseWorkspacePath,
  routeFromWorkspaceState,
  workspacePathFor,
} from "./workspaceRouter.js";

function routeFromLocation() {
  if (typeof window === "undefined") return { kind: "root" };
  return parseWorkspacePath(window.location.pathname);
}

function requiresImportReviewSurface(room) {
  return Boolean(room.activeImportReview && (!room.activeImportReview.recovery || room.intakeOpen));
}

function focusRouteHeading() {
  window.requestAnimationFrame(() => {
    const target = document.querySelector("[data-route-heading]") ?? document.querySelector("#decision-stage");
    target?.focus?.({ preventScroll: true });
  });
}

export function useWorkspaceNavigation(room, { onError } = {}) {
  const [route, setRoute] = useState(routeFromLocation);
  const [isNavigating, setIsNavigating] = useState(false);
  const hydrated = useRef(false);
  const transition = useRef(0);
  const navigating = useRef(false);
  const returnFromIntake = useRef(null);

  const commitLocation = useCallback((nextRoute, { replace = false, fromPop = false, rawPath } = {}) => {
    const canonicalPath = workspacePathFor(nextRoute) ?? rawPath ?? window.location.pathname;
    if (!fromPop) {
      if (replace) window.history.replaceState({ situationRoom: true }, "", canonicalPath);
      else if (window.location.pathname !== canonicalPath) window.history.pushState({ situationRoom: true }, "", canonicalPath);
    } else if (window.location.pathname !== canonicalPath) {
      window.history.replaceState({ situationRoom: true }, "", canonicalPath);
    }
    setRoute(nextRoute);
  }, []);

  const navigate = useCallback(async (routeOrPath, options = {}) => {
    let nextRoute = typeof routeOrPath === "string" ? parseWorkspacePath(routeOrPath) : routeOrPath;
    const rawPath = typeof routeOrPath === "string" ? routeOrPath : undefined;
    if (!nextRoute || typeof nextRoute !== "object") nextRoute = { kind: "not-found" };
    const token = ++transition.current;
    navigating.current = true;
    setIsNavigating(true);
    try {
      if (nextRoute.kind === "root") {
        nextRoute = room.activeCase ? routeFromWorkspaceState({ ...room, intakeOpen: false }) : { kind: "archive" };
        options = { ...options, replace: true };
      }

      let forcedByImportReview = false;
      if (requiresImportReviewSurface(room) && nextRoute.kind !== "new") {
        returnFromIntake.current = {
          path: workspacePathFor(nextRoute)
            ?? workspacePathFor(routeFromWorkspaceState({ ...room, intakeOpen: false }))
            ?? "/cases",
          caseId: room.activeCase?.id ?? null,
        };
        nextRoute = { kind: "new" };
        options = { ...options, replace: true };
        forcedByImportReview = true;
      }

      if (nextRoute.kind === "not-found") {
        setNavigationSurface("not-found");
        commitLocation(nextRoute, { ...options, rawPath });
        if (options.focus !== false) focusRouteHeading();
        return { ok: false, reason: "not-found" };
      }

      if (nextRoute.kind === "archive") {
        if (room.intakeOpen) toggleIntake(false);
        setNavigationSurface("archive");
        commitLocation(nextRoute, options);
        if (options.focus !== false) focusRouteHeading();
        return { ok: true, route: nextRoute };
      }

      if (nextRoute.kind === "new") {
        if (!forcedByImportReview) {
          const locationRoute = parseWorkspacePath(window.location.pathname);
          const returnPath = locationRoute.kind !== "new"
            ? workspacePathFor(locationRoute)
            : null;
          returnFromIntake.current = {
            path: returnPath
              ?? workspacePathFor(routeFromWorkspaceState({ ...room, intakeOpen: false }))
              ?? "/cases",
            caseId: room.activeCase?.id ?? null,
          };
        }
        setNavigationSurface("new");
        if (!room.intakeOpen) toggleIntake(true);
        commitLocation(nextRoute, options);
        return { ok: true, route: nextRoute };
      }

      if (nextRoute.kind === "case") {
        const knownCase = room.workspace.cases.some((item) => item.id === nextRoute.caseId);
        if (!knownCase) {
          const missing = { kind: "not-found" };
          setNavigationSurface("not-found");
          commitLocation(missing, { ...options, rawPath: rawPath ?? workspacePathFor(nextRoute) });
          if (options.focus !== false) focusRouteHeading();
          return { ok: false, reason: "unknown-case" };
        }
        if (room.intakeOpen) toggleIntake(false);
        setNavigationSurface("transition");
        const result = await navigateWorkspaceRoute(nextRoute);
        if (token !== transition.current) return { ok: false, reason: "superseded" };
        if (!result?.ok) {
          const actualRoom = getWorkspaceStoreState();
          const actualRoute = routeFromWorkspaceState({ ...actualRoom, intakeOpen: false });
          setNavigationSurface("case");
          commitLocation(actualRoute, {
            replace: options.fromPop === true,
            fromPop: options.fromPop,
          });
          if (options.focus !== false) focusRouteHeading();
          return result;
        }
        setNavigationSurface("case");
        commitLocation(nextRoute, options);
        if (options.focus !== false) focusRouteHeading();
        return { ok: true, route: nextRoute };
      }

      return { ok: false, reason: "unsupported-route" };
    } catch (error) {
      setNavigationSurface(room.activeCase ? "case" : "archive");
      onError?.(error);
      return { ok: false, reason: "navigation-error", error };
    } finally {
      if (token === transition.current) {
        navigating.current = false;
        setIsNavigating(false);
      }
    }
  }, [commitLocation, onError, room]);

  useEffect(() => {
    if (room.bootStatus !== "ready" || hydrated.current) return;
    hydrated.current = true;
    void navigate(window.location.pathname, { replace: true, fromPop: true, focus: false });
  }, [navigate, room.bootStatus]);

  useEffect(() => {
    const handlePopState = () => {
      void navigate(window.location.pathname, { replace: true, fromPop: true });
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [navigate]);

  useEffect(() => {
    if (!hydrated.current || room.bootStatus !== "ready" || navigating.current) return;
    if ((room.intakeOpen || requiresImportReviewSurface(room)) && route.kind !== "new") {
      const returnPath = workspacePathFor(route)
        ?? workspacePathFor(routeFromWorkspaceState({ ...room, intakeOpen: false }))
        ?? "/cases";
      returnFromIntake.current = {
        path: returnPath,
        caseId: room.activeCase?.id ?? null,
      };
      setNavigationSurface("new");
      if (requiresImportReviewSurface(room)) window.history.replaceState({ situationRoom: true }, "", "/new");
      else window.history.pushState({ situationRoom: true }, "", "/new");
      setRoute({ kind: "new" });
      return;
    }
    if (route.kind === "new" && !room.intakeOpen) {
      const actualRoute = routeFromWorkspaceState({ ...room, intakeOpen: false });
      const actualPath = workspacePathFor(actualRoute) ?? "/cases";
      const returnTarget = returnFromIntake.current;
      const activeCaseChanged = Boolean(returnTarget?.caseId && returnTarget.caseId !== room.activeCase?.id);
      const fallback = activeCaseChanged ? actualPath : returnTarget?.path ?? actualPath;
      const nextRoute = parseWorkspacePath(fallback);
      setNavigationSurface(nextRoute.kind === "case" ? "case" : nextRoute.kind);
      window.history.replaceState({ situationRoom: true }, "", fallback);
      setRoute(nextRoute);
      returnFromIntake.current = null;
      return;
    }
    if (route.kind !== "case" || route.caseId !== room.activeCase?.id) return;
    const actualRoute = routeFromWorkspaceState({ ...room, intakeOpen: false });
    const actualPath = workspacePathFor(actualRoute);
    const currentPath = workspacePathFor(route);
    if (actualPath && actualPath !== currentPath) {
      window.history.replaceState({ situationRoom: true }, "", actualPath);
      setRoute(actualRoute);
    }
  }, [route, room]);

  return {
    route,
    navigate,
    isNavigating,
    canonicalPath: workspacePathFor(route),
  };
}
