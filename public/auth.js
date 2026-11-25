// When the Builder is reachable beyond its own machine it needs a token. The first refused request asks for it once,
// trades it for a cookie, and repeats the request; the token itself is never kept by the page.
const plainFetch = window.fetch.bind(window);
let asking = null;

async function signIn() {
  for (;;) {
    const token = window.prompt('Universe Builder token');
    if (!token) return false;
    const answer = await plainFetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    if (answer.ok) return true;
    window.alert('That token is not right.');
  }
}

window.fetch = async (input, init) => {
  const response = await plainFetch(input, init);
  if (response.status !== 401 || `${input}`.includes('/api/login')) return response;
  asking = asking || signIn().finally(() => { asking = null; });
  return (await asking) ? plainFetch(input, init) : response;
};
