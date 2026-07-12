import { House } from "lucide-react";
import { login } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="auth-page">
      <section className="auth-identity">
        <span className="brand"><span className="brand__mark"><House size={18} /></span><span><strong>Noir Haus</strong><small>Admin</small></span></span>
        <div><h1>Every stay, turnover, and arrival in one view.</h1><p>Private operations workspace for your short-term rental team.</p></div>
      </section>
      <section className="auth-panel">
        <form className="auth-form" action={login}>
          <h2>Sign in</h2>
          <p>Use your manager account.</p>
          <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="email" required /></div>
          <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required /></div>
          {error ? <p className="form-error" role="alert">Unable to sign in. Check your details.</p> : null}
          <button className="button button--primary" type="submit">Sign in</button>
        </form>
      </section>
    </main>
  );
}
