import {Operation} from "./Operation";
import {EmergencyMinerMission} from "../missions/EmergencyMission";
import {RefillMission} from "../missions/RefillMission";
import {PowerMission} from "../missions/PowerMission";
import {TerminalNetworkMission} from "../missions/TerminalNetworkMission";
import {IgorMission} from "../missions/IgorMission";
import {LinkMiningMission} from "../missions/LinkMiningMission";
import {MiningMission} from "../missions/MiningMission";
import {BuildMission} from "../missions/BuildMission";
import {LinkNetworkMission} from "../missions/LinkNetworkMission";
import {GeologyMission} from "../missions/GeologyMission";
import {UpgradeMission} from "../missions/UpgradeMission";
import {Coord, SeedData} from "../../interfaces";
import {helper} from "../../helpers/helper";
import {SeedAnalysis} from "../SeedAnalysis";
import {SpawnGroup} from "../SpawnGroup";
import {Empire} from "../Empire";
import {MasonMission} from "../missions/MasonMission";
import {OperationPriority} from "../../config/constants";

const GEO_SPAWN_COST = 5000;

export abstract class ControllerOperation extends Operation {

    constructor(flag: Flag, name: string, type: string, empire: Empire) {
        super(flag, name, type, empire);
        this.priority = OperationPriority.OwnedRoom;
        if (this.flag.room && this.flag.room.controller.level < 6) {
            this.priority = OperationPriority.VeryHigh;
        }
    }

    memory: {
        powerMining: boolean
        noMason: boolean
        masonPotency: number
        builderPotency: number
        wallBoost: boolean
        mason: { activateBoost: boolean }
        network: { scanData: { roomNames: string[]} }
        centerPosition: RoomPosition;
        centerPoint: Coord;
        rotation: number
        repairIndex: number
        temporaryPlacement: {[level: number]: boolean}
        checkLayoutIndex: number
        layoutMap: {[structureType: string]: Coord[]}
        radius: number
        seedData: SeedData
        lastChecked: {[structureType: string]: number }
        roadRepairIndex: number;

        // deprecated values
        flexLayoutMap: {[structureType: string]: Coord[]}
        flexRadius: number
    };

    staticStructures: {[structureType: string]: Coord[]};

    protected abstract addDefense();
    protected abstract initAutoLayout();
    protected abstract temporaryPlacement(controllerLevel: number);

    initOperation() {

        this.autoLayout();
        if (!this.flag.room) return; // TODO: remote revival

        // initOperation FortOperation variables
        this.spawnGroup = this.empire.getSpawnGroup(this.flag.room.name);
        if(!this.spawnGroup) {
            this.spawnGroup = this.findRemoteSpawn(6);
            if (!this.spawnGroup) return;
        }

        this.empire.register(this.flag.room);

        // spawn emergency miner if needed
        this.addMission(new EmergencyMinerMission(this));

        // refill spawning energy - will spawn small spawnCart if needed

        this.addMission(new RefillMission(this));

        this.addDefense();

        if (this.memory.powerMining) {
            this.addMission(new PowerMission(this));
        }

        // energy network
        if (this.flag.room.terminal && this.flag.room.storage) {
            this.addMission(new TerminalNetworkMission(this));
            this.addMission(new IgorMission(this));
        }

        // harvest energy
        for (let i = 0; i < this.sources.length; i++) {
            if (this.sources[i].pos.lookFor(LOOK_FLAGS).length > 0) continue;
            let source = this.sources[i];
            if (this.flag.room.controller.level === 8 && this.flag.room.storage) {
                let link = source.findMemoStructure(STRUCTURE_LINK, 2) as StructureLink;
                if (link) {
                    this.addMission(new LinkMiningMission(this, "miner" + i, source, link));
                    continue;
                }
            }
            this.addMission(new MiningMission(this, "miner" + i, source));
        }

        // build construction
        let buildMission = new BuildMission(this);
        this.addMission(buildMission);

        if (this.flag.room.storage) {
            // use link array near storage to fire energy at controller link (pre-rcl8)
            this.addMission(new LinkNetworkMission(this));
            // mine minerals
            this.addMission(new GeologyMission(this));
        }

        // upgrader controller
        let boostUpgraders = this.flag.room.controller.level < 8;
        let upgradeMission = new UpgradeMission(this, boostUpgraders);
        this.addMission(upgradeMission);

        // repair walls
        this.addMission(new MasonMission(this));

        this.towerRepair();

        if (this.flag.room.controller.level < 6) {
            let boostSpawnGroup = this.findRemoteSpawn(4);
            if (boostSpawnGroup) {
                upgradeMission.spawnGroup = boostSpawnGroup;
                buildMission.spawnGroup = boostSpawnGroup;
            }
        }
    }

    finalizeOperation() {
    }

    invalidateOperationCache() {
        this.memory.masonPotency = undefined;
        this.memory.builderPotency = undefined;
    }

    public nuke(x: number, y: number, roomName: string): string {
        let nuker = _.head(this.flag.room.find(FIND_MY_STRUCTURES, {filter: {structureType: STRUCTURE_NUKER}})) as StructureNuker;
        let outcome = nuker.launchNuke(new RoomPosition(x, y, roomName));
        if (outcome === OK) {
            this.empire.addNuke({tick: Game.time, roomName: roomName});
            return "NUKER: Bombs away! \\o/";
        }
        else {
            return `NUKER: error: ${outcome}`;
        }
    }

    addAllyRoom(roomName: string) {
        if (_.includes(this.memory.network.scanData.roomNames, roomName)) {
            return "NETWORK: " + roomName + " is already being scanned by " + this.name;
        }

        this.memory.network.scanData.roomNames.push(roomName);
        this.empire.addAllyForts([roomName]);
        return "NETWORK: added " + roomName + " to rooms scanned by " + this.name;
    }

    private autoLayout() {

        this.initWithSpawn();
        if (!this.memory.centerPosition || this.memory.rotation === undefined ) return;
        this.initAutoLayout();
        this.buildLayout();

    }

    private buildLayout() {
        let structureTypes = Object.keys(CONSTRUCTION_COST);

        if (this.memory.checkLayoutIndex === undefined || this.memory.checkLayoutIndex >= structureTypes.length) {
            this.memory.checkLayoutIndex = 0;
        }
        let structureType = structureTypes[this.memory.checkLayoutIndex++];

        this.fixedPlacement(structureType);
        this.temporaryPlacement(this.flag.room.controller.level);
    }

    private fixedPlacement(structureType: string) {
        let controllerLevel = this.flag.room.controller.level;
        let constructionPriority = controllerLevel * 10;
        if (Object.keys(Game.constructionSites).length > constructionPriority) return;
        if (structureType === STRUCTURE_RAMPART && controllerLevel < 5) return;
        if (!this.memory.lastChecked) this.memory.lastChecked = {};
        if (Game.time - this.memory.lastChecked[structureType] < 1000) return;

        let coords = this.layoutCoords(structureType);
        let allowedCount = this.allowedCount(structureType, controllerLevel);

        for (let i = 0; i < coords.length; i++) {
            if (i >= allowedCount) break;

            let coord = coords[i];
            let position = helper.coordToPosition(coord, this.memory.centerPosition, this.memory.rotation);
            let hasStructure = position.lookForStructure(structureType);
            if (hasStructure) continue;
            let hasConstruction = position.lookFor(LOOK_CONSTRUCTION_SITES)[0];
            if (hasConstruction) continue;

            let outcome = position.createConstructionSite(structureType);
            if (outcome === OK) {
                console.log(`LAYOUT: placing ${structureType} at ${position} (${this.name})`);
            }
            else {
                // console.log(`LAYOUT: bad construction placement: ${outcome}, ${structureType}, ${position} (${this.name})`);
            }

            return;
        }

        this.memory.lastChecked[structureType] = Game.time;
    }

    private recalculateLayout(layoutType?: string) {

        if (!this.memory.seedData) {
            let sourceData = [];
            for (let source of this.flag.room.find<Source>(FIND_SOURCES)) {
                sourceData.push({pos: source.pos, amount: 3000 })
            }
            this.memory.seedData = {
                sourceData: sourceData,
                seedScan: {},
                seedSelectData: undefined
            }
        }

        let analysis = new SeedAnalysis(this.flag.room, this.memory.seedData);
        let results = analysis.run(this.staticStructures, layoutType);
        if (results) {
            let centerPosition = new RoomPosition(results.origin.x, results.origin.y, this.flag.room.name);
            if (results.seedType === this.type) {
                console.log(`${this.name} found best seed of type ${results.seedType}, initiating auto-layout`);
                this.memory.centerPosition = centerPosition;
                this.memory.rotation = results.rotation;
            }
            else {
                console.log(`${this.name} found best seed of another type, replacing operation`);
                let flagName = `${results.seedType}_${this.name}`;
                Memory.flags[flagName] = { centerPosition: centerPosition, rotation: results.rotation };
                this.flag.pos.createFlag(flagName, COLOR_GREY);
                this.flag.remove();
            }
            this.memory.seedData = undefined; // clean-up memory
        }
        else {
            console.log(`${this.name} could not find a suitable auto-layout, consider using another spawn location or room`);
        }
    }

    protected allowedCount(structureType: string, level: number): number {
        if (level < 5 && (structureType === STRUCTURE_RAMPART || structureType === STRUCTURE_WALL)) {
            return 0;
        }

        return Math.min(CONTROLLER_STRUCTURES[structureType][level], this.layoutCoords(structureType).length)
    }

    protected layoutCoords(structureType: string): Coord[] {
        if (this.staticStructures[structureType]) {
            return this.staticStructures[structureType]
        }
        else if (this.memory.layoutMap && this.memory.layoutMap[structureType]) {
            return this.memory.layoutMap[structureType];
        }
        else {
            return [];
        }
    }

    private initWithSpawn() {
        if (!this.memory.centerPosition || this.memory.rotation === undefined) {
            let structureCount = this.flag.room.find(FIND_STRUCTURES).length;
            if (structureCount === 1) {
                this.recalculateLayout();
            }
            else if (structureCount > 1) {
                this.recalculateLayout(this.type)
            }
            return;
        }
    }

    protected towerRepair() {
        let towers = this.flag.room.findStructures(STRUCTURE_TOWER) as StructureTower[];
        if (towers.length === 0) return;

        if (Game.time % 4 === 0) {
            // repair ramparts
            let ramparts = this.flag.room.findStructures(STRUCTURE_RAMPART) as StructureRampart[];
            if (towers.length === 0 || ramparts.length === 0) return;

            let rampart = _(ramparts).sortBy("hits").head();

            rampart.pos.findClosestByRange<StructureTower>(towers).repair(rampart);
        }
        else if (Game.time % 4 === 2) {
            // repair roads
            let centerPosition = helper.deserializeRoomPosition(this.memory.centerPosition);
            let roadsInRange =  centerPosition.findInRange<StructureRoad>(this.flag.room.findStructures(STRUCTURE_ROAD) as StructureRoad[],
                this.memory.radius);
            if (this.memory.roadRepairIndex === undefined || this.memory.roadRepairIndex >= roadsInRange.length) {
                this.memory.roadRepairIndex = 0;
            }

            let road = roadsInRange[this.memory.roadRepairIndex++];
            let repairsNeeded = Math.floor((road.hitsMax - road.hits) / 800);
            if (repairsNeeded === 1) {
                let tower = road.pos.findClosestByRange(towers) as StructureTower;
                tower.repair(road);
            }
            else if (repairsNeeded > 1) {
                console.log(`significant road repair needed in ${this.name}, damage to road: ${road.hitsMax - road.hits}`);
                towers = _.sortBy(towers, (t: StructureTower) => road.pos.getRangeTo(t));
                for (let tower of towers) {
                    repairsNeeded--;
                    tower.repair(road);
                    if (repairsNeeded === 0) break;
                }
            }
        }
    }

    private findRemoteSpawn(distanceLimit: number): SpawnGroup {
        let remoteSpawn = _(this.empire.spawnGroups)
            .filter((s: SpawnGroup) => {
                return Game.map.getRoomLinearDistance(this.flag.pos.roomName, s.room.name) <= distanceLimit
                    && s.room.controller.level === 8
                    && s.averageAvailability() > .3
                    && s.isAvailable
            })
            .sortBy((s: SpawnGroup) => {
                return Game.map.getRoomLinearDistance(this.flag.pos.roomName, s.room.name)
            })
            .head();
        return remoteSpawn;
    }
}