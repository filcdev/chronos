import { Navigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { authClient } from '~/frontend/utils/authentication';

type PermissionGuardProps = {
  children: ReactNode;
  permission: string;
};

export function PermissionGuard({
  children,
  permission,
}: PermissionGuardProps) {
  const { data } = authClient.useSession();

  const user = data?.user;
  if (!user) {
    return <Navigate to="/auth/error" />;
  }

  if (
    !(user.permissions.includes(permission) || user.permissions.includes('*'))
  ) {
    return <Navigate to="/auth/error" />;
  }

  return <>{children}</>;
}
