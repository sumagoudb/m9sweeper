import { login } from '../../functions/login.js';
import { buildUrl } from '../../functions/build-url.js';
import { sleep } from '../../functions/sleep.js';
import { exec } from '../../functions/exec.js';
import config from '../../config.js';
import { Key } from 'webdriverio';
import { cleanCommand } from '../../functions/clean-command.js';

/**
 * Ensure that the Kube Bench page is functional and that KubeHunter audits work properly
 */
describe('KubeBench Page::', () => {
    // Login to m9sweeper and navigate to the KubeHunter page
    it('1 Login and navigate to page', async () => {
        // Login to m9sweeper
        await login();
        expect(browser).toHaveUrl(
            buildUrl('private/dashboard/group/1'),
            {message: "m9sweeper should have logged in and loaded the default dashboard"}
        );

        // Open the default cluster
        await $("//mat-card/div/span[contains(text(),'default-cluster')]").customClick("load-default-cluster");
        expect(browser).toHaveUrl(
            buildUrl('private/clusters/1/summary'),
            {message: "m9sweeper should be displaying the cluster summary for the default cluster"}
        );

        // Move to the KubeBench page
        await $("//mat-list/a[@title='Kube Bench']").customClick("kubebench-page");
        expect(browser).toHaveUrl(
            buildUrl('private/clusters/1/kubebench'),
            {message: "m9sweeper should be displaying the KubeHunter page"}
        );

        // Take a screenshot at the end so we can see the results
        await browser.customScreenshot("test-end");
    });


    // Run a KubeBench scan
    it('2 Run a one-time KubeBench scan', async () => {
        // Locate and click the Run Audit button
        await $("//mat-card-content//button[contains(normalize-space(), 'Run Audit')]").customClick('run-audit');
        expect(await $("//div[contains(@class, 'cdk-overlay-container')]//app-kube-bench-dialog")).toBePresent(
            {message: "The KubeBench environment selection window should be visable"}
        );

        // Locate the Environments dropdown and click on it to open the dropdown menu
        await $("//div[contains(@class, 'cdk-overlay-container')]//span[contains(normalize-space(), 'Environments')]/parent::div//mat-select")
            .customClick("open-environments-dropdown");
        expect(await $("//div[contains(@class, 'cdk-overlay-container')]//mat-option[contains(normalize-space(), 'Standard Kubernetes Environment - Just Master Benchmarks')]"))
            .toBePresent({message: "The Environments dropdown menu should be visable"});

        // Locate and click the Standard Kubernetes Environment - Just Master Benchmarks option from the dropdown
        await $("//div[contains(@class, 'cdk-overlay-container')]//mat-option[contains(normalize-space(), 'Standard Kubernetes Environment - Just Master Benchmarks')]")
            .customClick('select-environment');
        expect(await $("//div[contains(@class, 'cdk-overlay-container')]//span[contains(normalize-space(), 'Standard Kubernetes Environment - Just Master Benchmarks')]"))
            .toBePresent({message: "The Standard Kubernetes Environment - Just Master Benchmarks option should be selected"});

        // Locate and click the next button
        await $("//div[contains(@class, 'cdk-overlay-container')]//button[contains(normalize-space(), 'Next')]").customClick("next");
        expect(await $("//div[contains(@class, 'cdk-overlay-container')]//h2[contains(normalize-space(), 'Kube Bench periodically or manually')]"))
            .toBePresent({message: "The KubeBench run configuration options menu should be visable"});

        // Locate and select the Run one time option
        await $("//div[contains(@class, 'cdk-overlay-container')]//label[contains(normalize-space(), 'Run one time')]").customClick("choose-run-one-time");
        expect(await $("//div[contains(@class, 'cdk-overlay-container')]//label[contains(normalize-space(), 'Run one time')]/parent::mat-radio-button")).toHaveElementClassContaining(
            "mat-radio-checked",
            {message: "The Run on time radio button should be selected"}
        );

        // Locate the text area containing the helm cli command to use to run the audit
        let helmCommandText = (await (await $("//div[contains(@class, 'cdk-overlay-container')]//textarea")).getText()).trim();

        // Close the popup dialog
        await $("//div[contains(@class, 'cdk-overlay-container')]//button/span[contains(text(),'Done')]").customClick('done');
        expect(await $("//div[contains(@class, 'cdk-overlay-container')]//app-kube-bench-dialog")).not.toBePresent(
            {message: "Kube Hunter Run configuration window should not be visable"}
        );

        // Wait for 3 seconds to ensure log output is clear for the commands
        await sleep(3000);

        // Reformat the command into a single line of text with no \ line separators so that the shell can parse it properly
        helmCommandText = cleanCommand(helmCommandText);

        // Add the custom docker registry URL if one is supplied via environment variables
        if ((config.DOCKER_REGISTRY?.trim()?.length || 0) > 0) {
            helmCommandText = helmCommandText + ` --set-string image.repository='${config.DOCKER_REGISTRY}/aquasec/kube-bench'`;
        }

        // Execute the commands to run the kube-bench pod and generate a report
        const exitCode = await exec(`${helmCommandText} --debug`);
        expect(exitCode).toEqual(0);

        // Wait 15 seconds for m9sweeper to load the report from kube-bench
        await sleep(15000);

        // Reload the page we are currently on so we can get an updated test status
        await browser.refresh();

        // Wait 5 seconds to let the page finish loading after the refresh
        await sleep(5000);

        // Verify that we have a result in the table
        expect(await $(`//mat-table//mat-row[contains(normalize-space(), '${(new Date()).getFullYear()}')]`)).toBePresent(
            {message: "A KubeBench result should be present"}
        );

        // Take a screenshot at the end so we can see the results
        await browser.customScreenshot("test-end");
    });


    // TODO
    // Verify we can view the report page itself
    // it('3 Verify report page', async () => {
    // });
});