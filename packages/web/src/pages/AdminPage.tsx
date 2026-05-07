import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { ContentTabs, TabPanel } from "../components/ui/ContentTabs.js";
import { TenantsTab } from "../components/admin/TenantsTab.js";
import { TeamsTab } from "../components/admin/TeamsTab.js";
import { UsersTab } from "../components/admin/UsersTab.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface AdminPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
  onToast?: (msg: string, type: string) => void;
}

/**
 * Admin Panel -- tenants, teams, users.
 *
 * Plain tables + confirm dialogs on destructive actions; uses the shared
 * toast helper wired through from App.tsx. Gated behind the admin role in
 * the sidebar -- the handler layer also refuses if the caller isn't admin
 * (see packages/conductor/handlers/admin.ts).
 */
export function AdminPage({ view, onNavigate, readOnly, daemonStatus, onToast }: AdminPageProps) {
  const [tab, setTab] = useState<string>("tenants");

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus}>
      <PageShell title="Admin" padded={false}>
        <ContentTabs
          tabs={[
            { id: "tenants", label: "Tenants" },
            { id: "teams", label: "Teams" },
            { id: "users", label: "Users" },
          ]}
          activeTab={tab}
          onTabChange={setTab}
        />
        <div className="flex-1 min-h-0">
          {tab === "tenants" && (
            <TabPanel tabId="tenants" className="h-full">
              <TenantsTab onToast={onToast} />
            </TabPanel>
          )}
          {tab === "teams" && (
            <TabPanel tabId="teams" className="h-full">
              <TeamsTab onToast={onToast} />
            </TabPanel>
          )}
          {tab === "users" && (
            <TabPanel tabId="users" className="h-full">
              <UsersTab onToast={onToast} />
            </TabPanel>
          )}
        </div>
      </PageShell>
    </Layout>
  );
}
