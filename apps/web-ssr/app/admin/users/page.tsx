"use client";

import { useEffect, useState } from "react";
import AdminShell from "../components/AdminShell";
import { adminDisableUser, adminListUsers, adminSetUserRole, getToken } from "../../lib/api.js";

type AdminUser = {
  id: string;
  email: string;
  role?: string;
  disabled?: boolean;
  createdAt?: string;
};

export default function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  async function loadUsers(nextSearch = search) {
    setLoading(true);
    setError("");
    try {
      const out = await adminListUsers(nextSearch);
      setUsers(Array.isArray(out?.users) ? out.users : []);
    } catch (err: any) {
      setError(String(err?.message || err));
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!getToken()) return;
    void loadUsers("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onToggleDisable(user: AdminUser) {
    setBusyId(user.id);
    setError("");
    try {
      await adminDisableUser(user.id, !Boolean(user.disabled));
      await loadUsers();
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusyId("");
    }
  }

  async function onRoleChange(user: AdminUser, role: string) {
    setBusyId(user.id);
    setError("");
    try {
      await adminSetUserRole(user.id, role);
      await loadUsers();
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusyId("");
    }
  }

  return (
    <AdminShell title="Admin Users">
      <div className="adminToolbar">
        <input
          className="input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by email or user id"
        />
        <button className="btn" onClick={() => loadUsers()} disabled={loading}>
          {loading ? "Loading..." : "Search"}
        </button>
      </div>

      {!getToken() ? <div className="alert alertErr">Save an admin token first.</div> : null}
      {error ? <div className="alert alertErr">{error}</div> : null}

      <div className="adminTableWrap">
        <table className="adminTable">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Disabled</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="adminCellMain">{u.email}</div>
                  <div className="adminCellSub mono">{u.id}</div>
                </td>
                <td>
                  <select
                    className="input adminSelect"
                    value={String(u.role || "user")}
                    onChange={(e) => onRoleChange(u, e.target.value)}
                    disabled={busyId === u.id}
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td>{u.disabled ? "Yes" : "No"}</td>
                <td>{u.createdAt ? new Date(u.createdAt).toLocaleString() : "-"}</td>
                <td>
                  <button className="btn" onClick={() => onToggleDisable(u)} disabled={busyId === u.id}>
                    {u.disabled ? "Enable" : "Disable"}
                  </button>
                </td>
              </tr>
            ))}

            {!users.length ? (
              <tr>
                <td colSpan={5} className="muted">
                  No users found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
