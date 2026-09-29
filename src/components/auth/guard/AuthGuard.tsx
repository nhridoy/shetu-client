import { Navigate, Outlet, useLocation } from "react-router";
import Spinner from "@/components/ui/Spinner";
import { useAuthStore } from "@/stores/auth/authStore";

interface AuthGuardProps {
  requireAuth: boolean;
}

export function shouldRedirectPublicRoute(
  localAccessAccountId: string | null,
  routeState: unknown,
  serverAuthenticated: boolean,
): boolean {
  const explicitReauth =
    (routeState as { reauth?: boolean } | null)?.reauth === true;
  return Boolean(
    localAccessAccountId && (!explicitReauth || serverAuthenticated),
  );
}

export default function AuthGuard({ requireAuth }: AuthGuardProps) {
  const localAccessAccountId = useAuthStore((s) => s.localAccessAccountId);
  const serverAuthenticated = useAuthStore((s) => s.serverAuthenticated);
  const isInitialized = useAuthStore((s) => s.isInitialized);
  const location = useLocation();

  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-dark-950 flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (requireAuth && !localAccessAccountId) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (
    !requireAuth &&
    shouldRedirectPublicRoute(
      localAccessAccountId,
      location.state,
      serverAuthenticated,
    )
  ) {
    const from = (location.state as { from?: Location })?.from?.pathname;
    return <Navigate to={from || "/hosts"} replace />;
  }

  return <Outlet />;
}
