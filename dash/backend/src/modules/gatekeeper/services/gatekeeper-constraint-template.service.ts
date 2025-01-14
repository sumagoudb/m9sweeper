import {
  BadRequestException,
  forwardRef,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException
} from '@nestjs/common';
import { ClusterService } from '../../cluster/services/cluster.service';
import { ConfigService } from '@nestjs/config';
import { MineLoggerService } from '../../shared/services/mine-logger.service';
import { CustomObjectsApi, HttpError, PatchUtils } from '@kubernetes/client-node';
import { KubeConfig } from '@kubernetes/client-node/dist/config';
import { GatekeeperConstraintTemplateDto } from '../dto/gatekeeper-constraint-template.dto';
import { plainToInstance } from 'class-transformer';
import { GatekeeperConstraintService } from './gatekeeper-constraint.service';
import * as jsYaml from 'js-yaml';
import { GatekeeperConstraintDto } from '../dto/gatekeeper-constraint.dto';

@Injectable()
export class GatekeeperConstraintTemplateService {
  defaultTemplateDir: string;

  constructor(
    @Inject(forwardRef(() => ClusterService))
    private readonly clusterService: ClusterService,
    private readonly configService: ConfigService,
    private readonly gatekeeperConstraintService: GatekeeperConstraintService,
    private logger: MineLoggerService,
  ) {
    this.defaultTemplateDir = this.configService.get('gatekeeper.gatekeeperTemplateDir');
  }

  private validateConstraintTemplate(template: string, existingTemplateName?: string): { isValid: boolean, reason?: string } {
    let templateAsObject: GatekeeperConstraintTemplateDto;
    try {
      templateAsObject = jsYaml.load(template) as GatekeeperConstraintTemplateDto;
    } catch (e) {
      return { isValid: false, reason: 'Template is not a valid yaml object' };
    }

    if (Array.isArray(templateAsObject) || !Object.keys(templateAsObject).length) {
      return { isValid: false, reason: 'Template is empty' };
    }

    if (existingTemplateName && templateAsObject.metadata.name !== existingTemplateName) {
      return {
        isValid: false,
        reason: `Cannot update the Constraint Template's name. It must remain ${existingTemplateName}.`,
      }
    }
    if (templateAsObject.metadata.name !== templateAsObject.spec.crd.spec.names.kind.toLowerCase()) {
      return {
        isValid: false,
        reason: `Template's name must match the lowercase of the CRD's kind: ${templateAsObject.spec.crd.spec.names.kind.toLowerCase()}`,
      }
    }

    return { isValid: true };
  }

  async getConstraintTemplates(clusterId: number, kubeConfig?: KubeConfig): Promise<GatekeeperConstraintTemplateDto[]> {
    try {
      if (!kubeConfig) {
        kubeConfig = await this.clusterService.getKubeConfig(clusterId);
      }
      const customObjectApi = kubeConfig.makeApiClient(CustomObjectsApi);
      const templateListResponse = await customObjectApi.getClusterCustomObject('templates.gatekeeper.sh', 'v1beta1', 'constrainttemplates', '');
      const templates: any[] = templateListResponse.body['items'];
      const templateDTOs: GatekeeperConstraintTemplateDto[] = plainToInstance(GatekeeperConstraintTemplateDto, templates);
      for (const template of templateDTOs) {
        const constraints = await this.gatekeeperConstraintService.getConstraintsForTemplate(clusterId, template.metadata.name, kubeConfig);
        const constraintCount = constraints.length;
        template.constraintsCount = constraintCount;
        template.enforced = !!constraintCount;
        template.constraints = constraints;
      }
      return templateDTOs;
    } catch (e) {
      this.logger.error({label: 'Error getting Gatekeeper constraint templates', data: { clusterId }}, e, 'GatekeeperService.getConstraintTemplates');
      throw({message: 'Error getting Gatekeeper constraint templates'});
    }
  }

  async getConstraintTemplate(clusterId: number, templateName: string, excludeConstraints: boolean, kubeConfig?: KubeConfig): Promise<{
    associatedConstraints?: GatekeeperConstraintDto[],
    template: GatekeeperConstraintTemplateDto,
    rawConstraintTemplate: string,
  }> {
    try {
      if (!kubeConfig) {
        kubeConfig = await this.clusterService.getKubeConfig(clusterId);
      }
      const customObjectApi = kubeConfig.makeApiClient(CustomObjectsApi);
      const templateResponse = await customObjectApi.getClusterCustomObject('templates.gatekeeper.sh', 'v1beta1', 'constrainttemplates', templateName);
      const template = plainToInstance(GatekeeperConstraintTemplateDto, templateResponse.body);

      let constraints;
      if (!excludeConstraints) {
        try {
          constraints = await this.gatekeeperConstraintService.getConstraintsForTemplate(clusterId, template.metadata.name, kubeConfig);
          template.constraintsCount = constraints.length;
          template.enforced = !!constraints.length;
        } catch (e) {
          this.logger.log({
            label: `Failed to retrieve constraints for constraint template ${templateName}`,
            data: { error: e }
          }, 'GatekeeperConstraintTemplateService.getConstraintTemplates');
        }
      }
      return {
        associatedConstraints: constraints,
        template,
        rawConstraintTemplate: JSON.stringify(template),
      };
    } catch (e) {
      this.logger.error({label: 'Error getting Gatekeeper constraint template', data: { clusterId, templateName }}, e, 'GatekeeperConstraintTemplateService.getConstraintTemplates');
      throw({message: 'Error getting Gatekeeper constraint templates'});
    }
  }

  async createConstraintTemplates(
    clusterId: number,
    templates: { name: string, template: string }[]
  ): Promise<{
    successfullyDeployed: string[],
    unsuccessfullyDeployed: string[],
  }> {
    if (!templates.length) {
      throw new BadRequestException('Please include constraint templates to create in the body of the request');
    }

    const validationErrors = [];
    templates.forEach((template) => {
      const validationResult = this.validateConstraintTemplate(template.template);
      if (!validationResult.isValid) {
        validationErrors.push({ templateName: template.name, reason: validationResult.reason });
      }
    });
    if (validationErrors.length) {
      this.logger.log({label: 'New Gatekeeper constraint template(s) failed validation', data: validationErrors}, 'GatekeeperConstraintTemplateService.createConstraintTemplates');
      throw new BadRequestException({ data: validationErrors, message: 'Template(s) failed validation' });
    }

    const kubeConfig: KubeConfig = await this.clusterService.getKubeConfig(clusterId);
    const customObjectApi = kubeConfig.makeApiClient(CustomObjectsApi);

    const createTemplatePromises = [];
    templates.forEach((template) => {
      const gatekeeperTemplate = jsYaml.load(template.template) as GatekeeperConstraintTemplateDto;
      const templateDeployPromise = customObjectApi.createClusterCustomObject('templates.gatekeeper.sh', 'v1beta1', 'constrainttemplates', gatekeeperTemplate);
      createTemplatePromises.push(templateDeployPromise);
    });

    const results = await Promise.allSettled(createTemplatePromises);

    const successfullyDeployed = [];
    const unsuccessfullyDeployed = [];
    results.forEach((templateDeployedResult) => {
      if (templateDeployedResult.status === "fulfilled") {
        successfullyDeployed.push(templateDeployedResult.value.response.body.metadata.name);
        return;
      }
      // rejected
      unsuccessfullyDeployed.push(templateDeployedResult.reason.body.message);
      return;
    });

    this.logger.log({
      label: 'Attempted to deploy new Gatekeeper constraint templates',
      data: {
        clusterId, numTemplates: templates.length,
        successfullyDeployed, unsuccessfullyDeployed,
      },
    }, 'GatekeeperConstraintTemplateService.createConstraintTemplates');
    if (successfullyDeployed.length && unsuccessfullyDeployed.length) {
      throw new HttpException({ data: {successfullyDeployed, unsuccessfullyDeployed}, message: 'Some templates deployed; others did not' }, 400);
    } else if (unsuccessfullyDeployed.length) {
      throw new HttpException({ data: {successfullyDeployed, unsuccessfullyDeployed}, message: 'Failed to deploy the templates' }, 400);
    } else {
      return {successfullyDeployed, unsuccessfullyDeployed};
    }
  }

  async updateConstraintTemplate(clusterId: number, templateName: string, templateContents: string) {
    const validationResult = this.validateConstraintTemplate(templateContents, templateName);
    if (!validationResult.isValid) {
      this.logger.log(`New Gatekeeper constraint template failed validation: ${validationResult.reason}`, 'GatekeeperConstraintTemplateService.updateConstraintTemplate');
      throw new BadRequestException({ data: validationResult.reason, message: `Template failed validation: ${validationResult.reason}` });
    }
    const template = jsYaml.load(templateContents) as GatekeeperConstraintTemplateDto;
    try {
      const kubeConfig: KubeConfig = await this.clusterService.getKubeConfig(clusterId);
      const customObjectApi = kubeConfig.makeApiClient(CustomObjectsApi);

      const patchMetadataName = {op: 'replace', path: '/metadata/name', value: template.metadata.name };
      const patchMetadataAnnotations = {op: 'replace', path: '/metadata/annotations', value: template.metadata.annotations };
      const patchSpecKind = {op: 'replace', path: '/spec/crd/spec/names/kind', value: template.spec.crd.spec.names.kind };
      const patchSpecTargets = {op: 'replace', path: '/spec/targets', value: template.spec.targets };

      const patchTemplate = await customObjectApi.patchClusterCustomObject(
        'templates.gatekeeper.sh',
        'v1beta1', 'constrainttemplates', templateName,
        [patchMetadataName, patchMetadataAnnotations, patchSpecKind, patchSpecTargets],
        undefined, undefined, undefined,
        { 'headers': { 'Content-type': PatchUtils.PATCH_FORMAT_JSON_PATCH }},
      );
      this.logger.log({label: 'Patched Gatekeeper template successfully', data: { clusterId, template }}, 'GatekeeperConstraintTemplateService.updateConstraintTemplate');
      return;
    } catch (e) {
      this.logger.error({label: 'Error patching Gatekeeper template', data: { clusterId, templateName }}, e, 'GatekeeperConstraintTemplateService.updateConstraintTemplate');
      if (e instanceof HttpError) {
        throw new HttpException({message: e.body.message}, e.statusCode);
      }
      throw new HttpException({message: 'Error updating the template'}, 500);
    }
  }

  async deleteConstraintTemplate(clusterId: number, templateName: string) {
    const kubeConfig: KubeConfig = await this.clusterService.getKubeConfig(clusterId);
    const customObjectApi = kubeConfig.makeApiClient(CustomObjectsApi);
    try {
      const constraintsDeleted = await this.gatekeeperConstraintService.deleteConstraintsForTemplate(clusterId, templateName, kubeConfig);

      if (constraintsDeleted.constraintsExisted && constraintsDeleted.notDeleted?.length) {
        throw new InternalServerErrorException({
          data: {notDeleted: constraintsDeleted.notDeleted},
          message: 'Constraint Template not deleted: failed to delete all Constraints'
        });
      }

      const destroyTemplate = await customObjectApi.deleteClusterCustomObject('templates.gatekeeper.sh', 'v1beta1', 'constrainttemplates', templateName);
      return {message: `${templateName} and related constraints were deleted successfully`, status: 200};
    }
    catch(e) {
      this.logger.error({label: 'Error deleting Gatekeeper constraint template by name', data: { clusterId, templateName }}, e, 'GatekeeperConstraintTemplateService.deleteConstraintTemplate');
      throw new InternalServerErrorException(e);
    }
  }
}
