async function request(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '请求失败，请稍后重试。');
  return payload;
}

export const api = {
  modelStatus: () => request('/api/model/status'),
  journals: () => request('/api/journals'),
  listProjects: () => request('/api/projects'),
  getProject: (id) => request(`/api/projects/${id}`),
  createDemo: () => request('/api/demo', { method: 'POST' }),
  analyze: (formData) => request('/api/analyze', { method: 'POST', body: formData }),
  patchProject: (id, patch) =>
    request(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  runReviewFlow: (id, options = {}) =>
    request(`/api/projects/${id}/review-flow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    }),
};
