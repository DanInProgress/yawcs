/*
 * created: 2026-05-15
 * updated: 2026-05-15
 */
/**
 * CLAUDE ARTIFACT SANDBOX HARNESS
 * * This file provides TypeScript definitions for the custom APIs injected into
 * the claudemcpcontent.com iframe. By extending the global Window interface,
 * you can use these types to build local mock harnesses, custom GUI wrappers,
 * or VS Code extensions that intercept Claude's artifact lifecycle.
 */

/**
 * Basic payload structures for the RPC bridge.
 * @see https://github.com/search?q=repo%3Adsudomoin%2Fultimate-claude-gui%20submitElicitation&type=code
 * @see https://github.com/search?q=repo%3Atombelieber%2Fclaude-view%20submitElicitation&type=code
 */
export interface ClaudeRequest {
  type: string;
  payload?: Record<string, any>;
}

export interface ClaudeResponse {
  success: boolean;
  data?: any;
  error?: string;
}

export interface ClaudeNotification {
  type: 'state_change' | 'theme_update' | 'user_interaction' | string;
  data: any;
}

export interface AttachFilesOptions {
  accept?: string;
  multiple?: boolean;
}

/**
 * The primary RPC Bridge handling bidirectional communication
 * between the sandboxed Artifact and the main Claude chat UI.
 * @see https://github.com/alex6095/clawd-on-vscode/blob/59ff12238fec7a2bb13dd74015957aa65eab0657/media/clawd.js#L1097
 * @see https://github.com/CalvinMagezi/mts/blob/9c940cf2d09a8f858342a66d083cd5af71cbdf30/ui/desktop/src/components/MtsMessage.tsx#L33
 */
export interface ClaudeAppBridge {
  /**
   * Sends a structured data request back to the host window.
   * Commonly used to proxy browser features blocked by the sandbox.
   * * @example
   * await window.app.sendRequest({ type: 'toast', payload: { message: 'Saved!' } });
   */
  sendRequest(request: ClaudeRequest): Promise<ClaudeResponse>;

  /**
   * Emits a unidirectional notification to the host UI.
   * * @example
   * window.app.sendNotification({ type: 'loaded', data: { time: Date.now() } });
   */
  sendNotification(notification: ClaudeNotification): void;

  /**
   * Triggers the host's native file attachment workflow, allowing the user
   * to upload files directly into the Claude chat from the artifact context.
   * * @example
   * window.app.attachFiles({ accept: 'image/png,image/jpeg', multiple: true });
   */
  attachFiles(options?: AttachFilesOptions): Promise<void>;

  /**
   * Subscribes to notifications emitted by the host (e.g., dark mode toggles).
   * * @returns A cleanup function to unsubscribe the listener.
   * * @example
   * const unsubscribe = window.app.onNotification((event) => {
   * if (event.type === 'theme_update') setTheme(event.data.theme);
   * });
   */
  onNotification(callback: (notification: ClaudeNotification) => void): () => void;

  /**
   * Requests a layout change from the host UI (e.g., expanding the artifact panel).
   * * @example
   * window.app.requestDisplayMode('full'); // 'full', 'compact', 'split'
   */
  requestDisplayMode(mode: 'full' | 'compact' | 'split'): void;

  /**
   * Notifies the host to begin monitoring this iframe's scrollHeight
   * to dynamically resize the container without scrollbars.
   */
  setupAutoResize(): void;
}

/**
 * Elicitation & State Configuration
 * @see https://github.com/search?q=repo%3Aaaif-goose%2Fgoose%20submitElicitation&type=code
 * @see https://github.com/search?q=repo%3Aavogiatzis%2FAgentChat%20submitElicitation&type=code
 */
export interface ElicitationAnswer {
  elicitationId: string;
  answer: string | number | boolean | Record<string, any>;
}

/**
 * Options mapped from the dynamic streaming instantiation inside the artifact iframe.
 * @see https://github.com/CalvinMagezi/mts/blob/9c940cf2d09a8f858342a66d083cd5af71cbdf30/ui/desktop/src/components/MtsMessage.tsx#L33
 */
export interface StreamingRendererOptions {
  target: HTMLElement;
  initialState?: Record<string, any>;
  onComplete?: () => void;
}

/**
 * Global Claude Window Extensions
 */
interface ClaudeSandboxWindowAPI {

  /** * The core RPC bridge to the host chat UI.
   */
  app: ClaudeAppBridge;

  /**
   * IN-CHAT PROMPTING
   * Programmatically sends a new message to the LLM on the user's behalf.
   * Note: The community has observed Anthropic actively restricting/deprecating
   * this in some contexts to prevent autonomous looping outside of MCP/Goose frameworks.
   * * @example
   * window.sendPrompt("Please summarize the data I just entered in the form.");
   * @see https://www.reddit.com/r/ClaudeAI/comments/1t5inc0/sendprompt_has_been_removed_from_claude_web/
   */
  sendPrompt(prompt: string): void;

  /**
   * ELICITATION LIFECYCLE
   * Submits structured data back to the host as a hidden "tool use" response.
   * This is how interactive artifact forms report their state back to Claude's context window.
   * * @example
   * // Inside an artifact form submit handler
   * await window.submitElicitation("survey-step-1", { satisfaction: 5, comments: "Great!" });
   * @see https://github.com/search?q=repo%3Aaaif-goose%2Fgoose%20submitElicitation&type=code
   */
  submitElicitation(id: string, answer: any): Promise<void>;

  /**
   * Gathers all currently registered elicitation answers from the DOM.
   * @see https://github.com/search?q=repo%3Atombelieber%2Fclaude-view%20submitElicitation&type=code
   */
  collectElicitAnswers(): Record<string, any>;

  /**
   * Internal binding utility used by the host to wire React/HTML inputs to the elicitation state.
   */
  _wireElicitation(elementId: string, options: any): void;

  /**
   * RENDERING & HYDRATION
   * Consumes a stream of tokens/data from the host to incrementally render the UI.
   * In a mock harness, you would simulate this by feeding string chunks into the returned renderer.
   * @see https://github.com/CalvinMagezi/mts/blob/9c940cf2d09a8f858342a66d083cd5af71cbdf30/ui/desktop/src/components/MtsMessage.tsx#L33
   */
  createStreamingRenderer(options: StreamingRendererOptions): any;

  /**
   * Bootstraps the artifact context with environment variables (like themes, user data).
   */
  initHostContext(context: Record<string, any>): void;

  /**
   * SANDBOX POLYFILLS
   * Proxies for standard DOM APIs that are blocked by iframe security policies.
   */
  copyToClipboard(text: string): Promise<void>;
  openLink(url: string): void;

  /**
   * DOM PATCHES (AI Graphic Fixes)
   * Utility functions injected to fix common SVG rendering bugs produced by LLMs.
   */
  fixSvgTextOcclusion(): void;
  fixSvgClipping(): void;
  fixSvgTextEdgeClip(): void;

  /**
   * HOST STRINGS
   * Injected UI strings for standard artifact interactive elements.
   */
  __hostStrings: {
    clipLabel: string;
    grabLabel: string;
    clipDone: string;
    grabDone: string;
    [key: string]: string;
  };

  /**
   * EXPERIMENTAL / UNDOCUMENTED APIS
   * Discovered during ecosystem research. Allows direct text completion queries
   * from inside the artifact without an API key (tied to the user's session).
   * * @example
   * const result = await window.claude.complete({ prompt: "Generate a random name" });
   */
  claude?: {
    complete: (options: { prompt: string; max_tokens?: number }) => Promise<any>;
  };
}

export type ClaudeSandboxWindow = Window & ClaudeSandboxWindowAPI;

// Ensure TypeScript recognizes this file as a module augmenting the global scope.
declare global {
  interface Window extends ClaudeSandboxWindowAPI {}
}
