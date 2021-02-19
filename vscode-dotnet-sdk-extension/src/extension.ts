/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as cp from 'child_process';
import * as fs from 'fs';
import open = require('open');
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    AcquireErrorConfiguration,
    AcquisitionInvoker,
    callWithErrorHandling,
    DotnetAcquisitionRequested,
    DotnetCoreAcquisitionWorker,
    DotnetSDKAcquisitionStarted,
    enableExtensionTelemetry,
    ErrorConfiguration,
    ExtensionConfigurationWorker,
    formatIssueUrl,
    IDotnetAcquireContext,
    IDotnetUninstallContext,
    IEventStreamContext,
    IExtensionContext,
    IIssueContext,
    InstallationValidator,
    registerEventStream,
    VersionResolver,
    WindowDisplayWorker,
} from 'vscode-dotnet-runtime-library';
import { IWindowDisplayWorker } from 'vscode-dotnet-runtime-library/dist/EventStream/IWindowDisplayWorker';
import { dotnetCoreAcquisitionExtensionId } from './DotnetCoreAcquistionId';

// Extension constants
namespace configKeys {
    export const installTimeoutValue = 'installTimeoutValue';
    export const enableTelemetry = 'enableTelemetry';
}
namespace commandKeys {
    export const acquire = 'acquire';
    export const uninstallAll = 'uninstallAll';
    export const showAcquisitionLog = 'showAcquisitionLog';
    export const reportIssue = 'reportIssue';
}
const commandPrefix = 'dotnet-sdk';
const configPrefix = 'dotnetSDKAcquisitionExtension';
const displayChannelName = '.NET SDK';
const defaultTimeoutValue = 240;
const pathTroubleshootingOption = 'Troubleshoot';
const troubleshootingUrl = 'https://github.com/dotnet/vscode-dotnet-runtime/blob/master/Documentation/troubleshooting-sdk.md';

export function activate(context: vscode.ExtensionContext, extensionContext?: IExtensionContext) {
    const extensionConfiguration = extensionContext !== undefined && extensionContext.extensionConfiguration ?
        extensionContext.extensionConfiguration :
        vscode.workspace.getConfiguration(configPrefix);

    const eventStreamContext = {
        displayChannelName,
        logPath: context.logPath,
        extensionId: dotnetCoreAcquisitionExtensionId,
        enableTelemetry: enableExtensionTelemetry(extensionConfiguration, configKeys.enableTelemetry),
        telemetryReporter: extensionContext ? extensionContext.telemetryReporter : undefined,
        showLogCommand: `${commandPrefix}.${commandKeys.showAcquisitionLog}`,
    } as IEventStreamContext;
    const [eventStream, outputChannel, loggingObserver, eventStreamObservers] = registerEventStream(eventStreamContext);

    const displayWorker = extensionContext ? extensionContext.displayWorker : new WindowDisplayWorker();
    const extensionConfigWorker = new ExtensionConfigurationWorker(extensionConfiguration, undefined);
    const issueContext = (errorConfiguration: ErrorConfiguration | undefined, commandName: string, version?: string) => {
        return {
            logger: loggingObserver,
            errorConfiguration: errorConfiguration || AcquireErrorConfiguration.DisplayAllErrorPopups,
            displayWorker,
            extensionConfigWorker,
            eventStream,
            commandName,
            version,
            timeoutInfoUrl: `${troubleshootingUrl}#install-script-timeouts`,
            moreInfoUrl: troubleshootingUrl,
        } as IIssueContext;
    };
    const timeoutValue = extensionConfiguration.get<number>(configKeys.installTimeoutValue);
    let storagePath: string;
    if (os.platform() === 'win32') {
        // Install to %AppData% on windows to avoid running into long path errors
        storagePath = process.env.APPDATA ? process.env.APPDATA : context.globalStoragePath;
    } else {
        storagePath = context.globalStoragePath;
        if (!fs.existsSync(storagePath)) {
            fs.mkdirSync(storagePath);
        }
    }

    const acquisitionWorker = new DotnetCoreAcquisitionWorker({
        storagePath,
        extensionState: context.globalState,
        eventStream,
        acquisitionInvoker: new AcquisitionInvoker(context.globalState, eventStream),
        installationValidator: new InstallationValidator(eventStream),
        timeoutValue: timeoutValue === undefined ? defaultTimeoutValue : timeoutValue,
    });
    const versionResolver = new VersionResolver(context.globalState, eventStream);

    const dotnetAcquireRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.acquire}`, async (commandContext: IDotnetAcquireContext) => {
        const pathResult = callWithErrorHandling(async () => {
            eventStream.post(new DotnetSDKAcquisitionStarted());

            eventStream.post(new DotnetAcquisitionRequested(commandContext.version, commandContext.requestingExtensionId));
            const resolvedVersion = await versionResolver.getFullSDKVersion(commandContext.version);
            const dotnetPath = await acquisitionWorker.acquireSDK(resolvedVersion);
            displayWorker.showInformationMessage(`.NET SDK ${commandContext.version} installed to ${dotnetPath.dotnetPath}`, () => { /* No callback needed */ });
            const pathEnvVar = path.dirname(dotnetPath.dotnetPath);
            setPathEnvVar(pathEnvVar, displayWorker);
            return dotnetPath;
        }, issueContext(commandContext.errorConfiguration, 'acquireSDK'));
        return pathResult;
    });
    const dotnetUninstallAllRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.uninstallAll}`, async (commandContext: IDotnetUninstallContext | undefined) => {
        await callWithErrorHandling(async () => {
            await acquisitionWorker.uninstallAll();
            displayWorker.showInformationMessage('All VS Code copies of the .NET SDK uninstalled.', () => { /* No callback needed */ });
        }, issueContext(commandContext ? commandContext.errorConfiguration : undefined, 'uninstallAll'));
    });
    const showOutputChannelRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.showAcquisitionLog}`, () => outputChannel.show(/* preserveFocus */ false));
    const reportIssueRegistration = vscode.commands.registerCommand(`${commandPrefix}.${commandKeys.reportIssue}`, async () => {
        const [url, issueBody] = formatIssueUrl(undefined, issueContext(AcquireErrorConfiguration.DisableErrorPopups, 'reportIssue'));
        await vscode.env.clipboard.writeText(issueBody);
        open(url);
    });

    context.subscriptions.push(
        dotnetAcquireRegistration,
        dotnetUninstallAllRegistration,
        showOutputChannelRegistration,
        reportIssueRegistration,
        ...eventStreamObservers);
}

function setPathEnvVar(pathAddition: string, displayWorker: IWindowDisplayWorker) {
    if (process.env.PATH && process.env.PATH.includes(pathAddition)) {
        // No need to add to PATH again
        return;
    }

    let pathCommand: string;
    if (os.platform() === 'win32') {
        pathCommand = `for /F "skip=2 tokens=1,2*" %A in ('%SystemRoot%\\System32\\reg.exe query "HKCU\\Environment" /v "Path" 2^>nul') do ` +
                      `(%SystemRoot%\\System32\\reg.exe ADD "HKCU\\Environment" /v Path /t REG_SZ /f /d "${pathAddition};%C")`;
    } else {
        // Adding to the user path is only supported on windows right now
        return;
    }
    try {
        cp.execSync(pathCommand);
    } catch (error) {
        displayWorker.showWarningMessage(`Unable to add SDK to the PATH: ${error}`,
            async (response: string | undefined) => {
                if (response === pathTroubleshootingOption) {
                    open(`${troubleshootingUrl}#unable-to-add-to-path`);
                }
            }, pathTroubleshootingOption);
    }
}