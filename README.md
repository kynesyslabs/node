# Demos Network Node

The official node implementation for the Demos Network - a decentralized network enabling secure, cross-chain communication and computation.

## Overview

This repository contains the core node software that allows machines to participate in the Demos Network as validators and service providers. The Demos Network is designed to facilitate secure cross-chain operations, privacy-preserving computations, and decentralized services across multiple blockchain ecosystems.

## The Demos Yellowpaper

Demos is defined by the Yellowpaper publicly available in [its own repository](https://github.com/kynesyslabs/demos_yellowpaper).

## System Requirements

### Minimum Requirements
- 4GB RAM
- 4 CPU cores (2GHz or higher)
- Modern SSD storage
- 200 Mbps internet connection
- Ubuntu 22.04 LTS or compatible Linux distribution

### Recommended Specifications
- 8GB RAM or higher
- 6 CPU cores (2GHz or higher)
- High-performance SSD storage
- 1 Gbps internet connection

## Installation

For detailed installation instructions, please refer to [INSTALL.md](INSTALL.md). The installation guide covers:

- System prerequisites and dependencies
- Docker and container setup
- Node configuration and key generation
- Network peer configuration
- Troubleshooting common issues

## Quick Start

1. Install prerequisites (Docker, Bun runtime)
2. Clone this repository
3. Install dependencies with `bun install`
4. Configure your node settings
5. Run `./run` to start the node

For complete step-by-step instructions, see [INSTALL.md](INSTALL.md).

## Technology Stack

- **Runtime**: Bun (required due to performances and advanced native features)
- **Language**: TypeScript with modern ES modules
- **Database**: PostgreSQL with TypeORM
- **Web Framework**: Fastify with RESTful APIs
- **Networking**: Custom P2P protocol implementation
- **Cryptography**: Advanced encryption libraries and post-quantum algorithms

## Configuration

After installation, configure your node by editing:

- `.env`: Core node settings including network endpoints
- `demos_peerlist.json`: Known peer connections for network participation

## Security

The Demos Network node implements multiple layers of security:

- Cryptographic identity management with public/private key pairs
- Post-quantum cryptographic algorithms for future-proof security
- Secure peer-to-peer communication protocols
- Privacy-preserving computation capabilities

**Important**: Always keep your private key (`.demos_identity` file) secure and never share it publicly.

## Network Participation

Once your node is running, it will:

1. Generate a unique cryptographic identity
2. Connect to other network peers
3. Participate in consensus mechanisms
4. Process cross-chain transactions and computations
5. Contribute to network security and decentralization

## Development

This is the official implementation maintained by KyneSys Labs. The codebase follows TypeScript best practices with comprehensive error handling and type safety.

## Support

For technical support and community discussions, visit [demos.sh](https://demos.sh).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

We welcome contributions to the Demos Network node implementation! Before contributing, please read our comprehensive [Contributing Guide](CONTRIBUTING.md) which covers:

- Code style and naming conventions
- Development workflow and best practices  
- AI-assisted development guidelines
- Pull request process and review requirements
- Testing and quality standards

For quick reference, also see:
- [Coding Guidelines](GUIDELINES/CODING.md) - Detailed code style guide
- [AI Development Guidelines](GUIDELINES/VIBES.md) - Essential for AI-assisted development

---

**Demos Network** - Building the future of decentralized, cross-chain computing.