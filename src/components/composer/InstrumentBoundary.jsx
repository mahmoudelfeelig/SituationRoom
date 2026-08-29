import { Component } from "react";
import { IconAlertTriangle } from "@tabler/icons-react";

export class InstrumentBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    this.props.onRenderError?.({
      type: "instrument-render-error",
      instrumentId: this.props.instrumentId,
      message: error instanceof Error ? error.message : "Unknown render error",
    });
  }

  componentDidUpdate(previousProps) {
    if (previousProps.instrumentId !== this.props.instrumentId && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="instrument-render-fallback" role="alert" data-instrument-id={this.props.instrumentId}>
        <IconAlertTriangle size={20} aria-hidden="true" />
        <div>
          <strong>This instrument could not be rendered.</strong>
          <span>The remaining room is intact. Use the full causal outline for this item.</span>
        </div>
      </section>
    );
  }
}

