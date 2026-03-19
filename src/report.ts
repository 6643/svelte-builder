import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { BuildArtifacts } from "./build";

type AssetReportRow = {
    file: string;
    gzip: number;
    size: number;
    time?: string;
};

type AssetReportValueRow = {
    file: string;
    gzip: string;
    size: string;
    time?: string;
};

type AssetReportOptions = {
    includeTime?: boolean;
};

const padEnd = (value: string, width: number): string => value.padEnd(width, " ");

const padStart = (value: string, width: number): string => value.padStart(width, " ");

const formatBinarySize = (bytes: number): string => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

const createAssetValueRows = (rows: AssetReportRow[]): AssetReportValueRow[] =>
    rows.map((row) => ({
        file: row.file,
        gzip: formatBinarySize(row.gzip),
        size: formatBinarySize(row.size),
        time: row.time,
    }));

const createColumnWidths = (rows: AssetReportValueRow[], includeTime: boolean) => ({
    file: Math.max("File".length, ...rows.map((row) => row.file.length)),
    time: includeTime ? Math.max("Time".length, ...rows.map((row) => row.time?.length ?? 0)) : 0,
    gzip: Math.max("Gzip".length, ...rows.map((row) => row.gzip.length)),
    size: Math.max("Size".length, ...rows.map((row) => row.size.length)),
});

const formatAssetRow = (
    label: string,
    size: string,
    gzip: string,
    widths: { file: number; gzip: number; size: number; time: number },
    includeTime: boolean,
    time?: string,
): string =>
    [
        padEnd(label, widths.file),
        ...(includeTime ? [padStart(time ?? "", widths.time)] : []),
        padStart(size, widths.size),
        padStart(gzip, widths.gzip),
    ].join("  ");

const formatHeaderRow = (widths: { file: number; gzip: number; size: number; time: number }, includeTime: boolean): string =>
    [
        padEnd("File", widths.file),
        ...(includeTime ? [padStart("Time", widths.time)] : []),
        padStart("Size", widths.size),
        padStart("Gzip", widths.gzip),
    ].join("  ");

export const formatAssetReport = (title: string, rows: AssetReportRow[], options: AssetReportOptions = {}): string => {
    const includeTime = options.includeTime ?? false;
    const valueRows = createAssetValueRows(rows);
    const widths = createColumnWidths(valueRows, includeTime);

    return [
        title,
        "",
        formatHeaderRow(widths, includeTime),
        ...valueRows.map((row) => formatAssetRow(row.file, row.size, row.gzip, widths, includeTime, row.time)),
    ].join("\n");
};

export const formatBuildReport = (artifacts: BuildArtifacts): string => {
    const rows = [artifacts.jsFile, artifacts.cssFile, artifacts.htmlFile].map((file) => {
        const buffer = readFileSync(join(artifacts.outDir, file));

        return {
            file,
            gzip: gzipSync(buffer).byteLength,
            size: buffer.byteLength,
        };
    });

    return formatAssetReport("Entry assets", rows);
};
