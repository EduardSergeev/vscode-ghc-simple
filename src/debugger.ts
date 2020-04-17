import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, Breakpoint, StoppedEvent, StackFrame, Thread, Source, TerminatedEvent, Scope
} from 'vscode-debugadapter';
import * as vscode from 'vscode';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Session } from './session';
import { ExtensionState, startSession } from './extension-state';
import { ProviderResult, WorkspaceFolder, TextDocument } from 'vscode';
const { Subject } = require('await-notify');
import * as path from 'path';


export function registerDebugger(ext: ExtensionState) {
    class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

        createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
            return new vscode.DebugAdapterInlineImplementation(new GhciDebugSession(ext));
        }
    }

	const provider = new GhciConfigurationProvider(ext);
	ext.context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('ghci', provider));


	ext.context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory(
            'ghci',
            new InlineDebugAdapterFactory()));
}

class GhciConfigurationProvider implements vscode.DebugConfigurationProvider {
    private _ext: ExtensionState;

	public constructor(ext: ExtensionState) {
        this._ext = ext;
	}

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): ProviderResult<vscode.DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'haskell') {
				config.type = 'ghci';
				config.name = 'Launch';
				config.request = 'launch';
                config.module = 'Main';
				config.function = 'main';
				config.stopOnEntry = false;
			}
		}

		if (!config.module) {
			return vscode.window.showInformationMessage("Cannot find a module to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		return config;
	}
}


/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	module: string;
    function: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
}

export class GhciDebugSession extends LoggingDebugSession {
    private _ext: ExtensionState;
	private _session: Session;
	private _configurationDone = new Subject();

    private _breakpoints: DebugProtocol.Breakpoint[] = [];
    private _stoppedAt: { name: string, path: string, line: number, column: number };
    private _variables: DebugProtocol.Variable[];

	public constructor(ext: ExtensionState) {
		super("ghci-debug.txt");
        this._ext = ext;
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = true;

		this.sendResponse(response);
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

        this._session = await startSession(this._ext, vscode.window.activeTextEditor.document);
        await this._session.loading;
        await this._session.ghci.sendCommand(
            `:load ${args.module}`
        );

        this.sendEvent(new InitializedEvent());

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(10000);

        this._session.ghci.sendCommand(
            args.stopOnEntry ? `:step ${args.function}` : args.function
        ).then(response => this.didStop(response));

		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        const source = args.source;
		// clear all breakpoints for this file
        this._breakpoints = [];
        await this._session.ghci.sendCommand(
            ':delete *'
        );

		// set breakpoint locations
		this._breakpoints = await Promise.all(
            args.breakpoints.map(async breakpoint => {
                const response = await this._session.ghci.sendCommand(
                    `:break ${args.source.name.split(".")[0]} ${breakpoint.line}`
                );
                const [, id, line, column] =
                    response[0].match(/Breakpoint\s(\d+).+?:(\d+):(\d+)-(\d+)/) ||
                    response[0].match(/Breakpoint\s(\d+).+?:\((\d+),(\d+)\)-\((\d+),(\d+)\)/);
                const bp = <DebugProtocol.Breakpoint> new Breakpoint(
                    true,
                    Number(line),
                    Number(column),
                    new Source(source.name, source.path));
                bp.id= Number(id);
                return bp;
            })
        );
		response.body = {
			breakpoints: this._breakpoints
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: [
				new Thread(1, "default")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		response.body = {
			stackFrames: [
                new StackFrame(
                    0,
                    this._stoppedAt.name.split(".").slice(-1)[0],
                    new Source(path.basename(this._stoppedAt.path), this._stoppedAt.path),
                    this._stoppedAt.line,
                    this._stoppedAt.column)],
			totalFrames: 1
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		response.body = {
			scopes: [
				new Scope("Local", 1, false)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
		response.body = {
			variables: this._variables
		};
		this.sendResponse(response);
	}

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        const variable = this._variables.find(variable =>
            variable.name === args.expression);
        if(variable) {
            response.body = {
                result: variable.value,
                variablesReference: 0
            }
        } else {
            const output = await this._session.ghci.sendCommand(
                args.expression
            );
            if(output[0].length) {
                const match = output[0].match(/\[.+\]\s+(.+)/);
                if(match) {
                    response.body = {
                        result: match[1],
                        variablesReference: 0
                    }
                }
            }
        }
        this.sendResponse(response);
    }



	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
        this._session.ghci.sendCommand(
            ':continue'
        ).then(response => this.didStop(response));
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        this._session.ghci.sendCommand(
            ':step'
        ).then(response => this.didStop(response));
		this.sendResponse(response);
	}


    private didStop(response: string[]) {
        const output = response.join('\n');
        const match =
            output.match(/Stopped in (\S+),\s(.*):(\d+):(\d+)/) ||
            output.match(/Stopped in (\S+),\s(.*):\((\d+),(\d+)\)/);
        if(match) {
            const [, name, path, line, column] = match;
            this._stoppedAt = {
                name: name,
                path: path,
                line: Number(line),
                column: Number(column)
            };

            this._variables = [];
            for (let match, pattern = /(.+?) :: (.+?) = (.+)/g; match = pattern.exec(output);) {
                const [, name, type, value] = match;
                this._variables.push({
                    name: name,
                    type: type,
                    value: value,
                    variablesReference: 0
                })
            }
            if(this._breakpoints.find(breakpoint =>
                breakpoint.line === this._stoppedAt.line && breakpoint.column === this._stoppedAt.column)) {
                this.sendEvent(new StoppedEvent('breakpoint', 1));
            } else {
                this.sendEvent(new StoppedEvent('step', 1));
            }
        } else {
            this.sendEvent(new TerminatedEvent());
        }
    }
}
