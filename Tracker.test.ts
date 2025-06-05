import { GitHubServiceAnalyzer, ServiceDependency } from './Tracker';

describe('GitHubServiceAnalyzer', () => {
  const mockToken = 'mock-token';
  const mockOrg = 'mock-org';
  
  let analyzer: GitHubServiceAnalyzer;

  beforeEach(() => {
    analyzer = new GitHubServiceAnalyzer(mockToken, mockOrg, {
      debugMode: true,
      fileProcessingLimit: 10
    });
  });

  describe('filterByConfidence', () => {
    it('should filter dependencies by confidence level', () => {
      const dependencies: ServiceDependency[] = [
        { consumer: 'repo1', producer: 'service1', type: 'service', source: 'file1', confidence: 'high' },
        { consumer: 'repo2', producer: 'service2', type: 'service', source: 'file2', confidence: 'medium' },
        { consumer: 'repo3', producer: 'service3', type: 'service', source: 'file3', confidence: 'low' }
      ];

      const highConfidence = analyzer.filterByConfidence(dependencies, 'high');
      expect(highConfidence).toHaveLength(1);
      expect(highConfidence[0].confidence).toBe('high');
    });
  });

  describe('filterByType', () => {
    it('should filter dependencies by type', () => {
      const dependencies: ServiceDependency[] = [
        { consumer: 'repo1', producer: 'service1', type: 'service', source: 'file1', confidence: 'high' },
        { consumer: 'repo2', producer: 'service2', type: 'package', source: 'file2', confidence: 'high' },
        { consumer: 'repo3', producer: 'service3', type: 'api', source: 'file3', confidence: 'high' }
      ];

      const serviceDeps = analyzer.filterByType(dependencies, 'service');
      expect(serviceDeps).toHaveLength(1);
      expect(serviceDeps[0].type).toBe('service');
    });
  });

  describe('getHighImpactServices', () => {
    it('should identify high-impact services', () => {
      const graph = {
        services: new Map([
          ['service1', {
            name: 'service1',
            producers: ['repo1'],
            consumers: ['repo2', 'repo3', 'repo4', 'repo5', 'repo6'],
            dependencies: []
          }],
          ['service2', {
            name: 'service2',
            producers: ['repo1'],
            consumers: ['repo2', 'repo3'],
            dependencies: []
          }]
        ]),
        repositories: ['repo1', 'repo2', 'repo3', 'repo4', 'repo5', 'repo6']
      };

      const highImpact = analyzer.getHighImpactServices(graph, 5);
      expect(highImpact.size).toBe(1);
      expect(highImpact.has('service1')).toBe(true);
    });
  });
}); 