import {Injectable} from '@nestjs/common';
import * as fs from 'fs';
import {Content, TDocumentDefinitions} from 'pdfmake/interfaces';
import {ConfigService} from '@nestjs/config';
import {assetsConfig} from '../../../config/types/assets-config';
import {format} from 'date-fns';
import {ClusterService} from '../../cluster/services/cluster.service';import {PdfMakeService} from '../../shared/services/pdf-make.service';
import {SecurityAuditReportPdfHelpersService} from './security-audit-report-pdf-helpers.service';
import {SecurityAuditClusterService} from './security-audit-cluster.service';
import {SecurityAuditReportCluster} from '../interfaces/security-audit-report-cluster';
import {SecurityAuditReportTools} from '../enums/security-audit-report-tools';
import {SecurityAuditToolServiceFactory} from './security-audit-tool-service.factory';

@Injectable()
export class SecurityAuditReportService {

  constructor(
    protected readonly config: ConfigService,
    protected readonly clusterService: ClusterService,
    protected readonly pdfService: PdfMakeService,
    protected readonly securityAuditClusterService: SecurityAuditClusterService,
    protected readonly pdfHelpers: SecurityAuditReportPdfHelpersService,
    protected readonly securityAuditToolServiceFactory: SecurityAuditToolServiceFactory
  ) {

  }

  async generate(options?: { clusterIds: number[], namespaces?: string[],  tools?: SecurityAuditReportTools[] }): Promise<PDFKit.PDFDocument> {
    const today = format(new Date(), 'PPP');

    const definition: TDocumentDefinitions = {
      footer: (page: number) => {

        return {
          margin: [45, 0, 45, 0],
          columns: [
            { text: today },
            { text: page, alignment: 'right' }
          ]
        }
      },
      content: [
        ...this.buildIntro()
      ],
      styles: this.pdfHelpers.buildStyles()
    };
    const clusters = await this.clusterService.getClusterObjectSummaries({ clusterIds: options?.clusterIds, namespaces: options?.namespaces });

    // Filter out invalid tool names
    let tools = options?.tools?.filter(t => Object.values(SecurityAuditReportTools).includes(t));
    // If there are no tools, include all
    if (!tools?.length) {
      tools = Object.values(SecurityAuditReportTools);
    }

    // For each cluster, build its content for each tool
    const reportPromises: Promise<SecurityAuditReportCluster>[] = [];
    for (const cluster of clusters) {
      reportPromises.push(this.securityAuditClusterService.getClusterReportData(cluster, tools));
    }

    const reportsByCluster: SecurityAuditReportCluster[] = await Promise.all(reportPromises);

    // Build the overview section for each tool
    for (const tool of tools) {
      const summaries = reportsByCluster.map(report => report.toolResults[tool].summaryRow);
      const service = this.securityAuditToolServiceFactory.getTool(tool);
      (definition.content as Content[]).push(service.buildSummaryContent(summaries));
    }

    // Build the cluster details section for each cluster
    for (const report of reportsByCluster) {
      (definition.content as Content[]).push(this.securityAuditClusterService.buildClusterSummary(report, tools));
    }

    return this.pdfService.buildPdfStream(definition);
  }

  buildIntro(): Content[] {
    const assetsConfig = this.config.get<assetsConfig>('assets');
    return [
      { image: assetsConfig.imagesDirectory.concat('/m9sweeper-logo.png')},
      { text: 'Kubernetes Security Audit Report', style: 'title' },
      this.pdfHelpers.buildHeader('Overview', { skipToc: true }),
      {
        style: 'body',
          text: [
        'This security audit report was generated automatically by m9sweeper. ',
        'M9sweeper ran a number of kubernetes security tools to produce this report. ',
        'Each tool will be given a section along with a description of the tool, ',
        'what element of security it covers, and the results reported by the tool.',
        '\n\n',
        'A separate report will be given for each of your clusters as well as a summary of all of your clusters, if you have multiple.\n'
      ]
      },
      {
        marginBottom: 24,
        toc: {
          title: { text: 'Table of Contents', style: 'h1'},
        }
      }
    ];
  }
}