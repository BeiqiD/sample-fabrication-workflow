import { Component, createRef, type ReactNode } from "react";

/** A rejected lazy route or page render must leave the shared navigation usable.
 * Recovery is explicit: never reload a user's page or replay a saved operation
 * merely because loading a new deployment's code failed. */
export class RouteErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean }> {
  state = { failed: false };
  private recoveryRef = createRef<HTMLDivElement>();

  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.recoveryRef.current?.focus(); }
  componentDidUpdate(previous: Readonly<{ children: ReactNode; resetKey: string }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="page">
      <div ref={this.recoveryRef} className="card" role="alert" tabIndex={-1} aria-labelledby="route-error-title">
        <h1 id="route-error-title">This page could not be loaded</h1>
        <p className="muted">Reload the page to try again, or choose another page from the navigation above.</p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>Reload page</button>
      </div>
    </section>;
  }
}
