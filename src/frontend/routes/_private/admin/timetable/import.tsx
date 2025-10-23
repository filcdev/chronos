import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { parseResponse } from 'hono/client';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FaCalendarDays,
  FaCircleCheck,
  FaCircleExclamation,
  FaFileArrowUp,
  FaSpinner,
  FaXmark,
} from 'react-icons/fa6';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '~/frontend/components/ui/alert';
import { Button } from '~/frontend/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/frontend/components/ui/card';
import { PermissionGuard } from '~/frontend/components/util/permission-guard';
import { apiClient } from '~/frontend/utils/hc';

export const Route = createFileRoute('/_private/admin/timetable/import')({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <PermissionGuard permission="import:timetable">
      <TimetableImportPage />
    </PermissionGuard>
  );
}

type ImportStatus = 'idle' | 'uploading' | 'success' | 'error';

function TimetableImportPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const res = await parseResponse(
        apiClient.timetable.import.$post({
          form: { omanXml: file },
        })
      );

      if (!res?.success) {
        throw new Error('Failed to import timetable');
      }

      return res;
    },
    onMutate: () => {
      setImportStatus('uploading');
      setErrorMessage(null);
    },
    onSuccess: () => {
      setImportStatus('success');
      toast.success(t('timetable.importSuccess'));
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      // Invalidate any timetable-related queries
      queryClient.invalidateQueries({ queryKey: ['timetable'] });
      queryClient.invalidateQueries({ queryKey: ['lessons'] });
      queryClient.invalidateQueries({ queryKey: ['cohorts'] });
    },
    onError: (error: Error) => {
      setImportStatus('error');
      setErrorMessage(error.message);
      toast.error(t('timetable.importError'));
    },
  });

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Validate file type
      if (
        file.type !== 'text/xml' &&
        file.type !== 'application/xml' &&
        !file.name.endsWith('.xml')
      ) {
        toast.error(t('timetable.invalidFileType'));
        return;
      }
      setSelectedFile(file);
      setImportStatus('idle');
      setErrorMessage(null);
    }
  };

  const handleImport = () => {
    if (selectedFile) {
      importMutation.mutate(selectedFile);
    }
  };

  const handleClearFile = () => {
    setSelectedFile(null);
    setImportStatus('idle');
    setErrorMessage(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleBrowseClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="container mx-auto space-y-6 p-4 md:p-6">
      <div>
        <h1 className="font-bold text-3xl tracking-tight">
          {t('timetable.import')}
        </h1>
        <p className="text-muted-foreground">
          {t('timetable.importDescription')}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('timetable.uploadFile')}</CardTitle>
          <CardDescription>
            {t('timetable.uploadFileDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* File Upload Area */}
          <button
            className="relative flex min-h-[200px] w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-muted-foreground/25 border-dashed bg-transparent p-8 text-center transition-colors hover:border-muted-foreground/50"
            onClick={handleBrowseClick}
            onDragLeave={(e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('border-primary');
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.currentTarget.classList.add('border-primary');
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('border-primary');
              const file = e.dataTransfer.files[0];
              if (file) {
                if (
                  file.type !== 'text/xml' &&
                  file.type !== 'application/xml' &&
                  !file.name.endsWith('.xml')
                ) {
                  toast.error(t('timetable.invalidFileType'));
                  return;
                }
                setSelectedFile(file);
                setImportStatus('idle');
                setErrorMessage(null);
              }
            }}
            type="button"
          >
            <input
              accept=".xml,text/xml,application/xml"
              className="hidden"
              onChange={handleFileSelect}
              ref={fileInputRef}
              type="file"
            />

            {selectedFile ? (
              <div className="flex w-full items-center justify-between rounded-md bg-muted p-4">
                <div className="flex items-center gap-3">
                  <FaCalendarDays className="h-6 w-6 text-primary" />
                  <div className="flex flex-col">
                    <span className="font-medium text-sm">
                      {selectedFile.name}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {(selectedFile.size / 1024).toFixed(2)} KB
                    </span>
                  </div>
                </div>
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClearFile();
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <FaXmark className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <>
                <FaFileArrowUp className="mb-4 h-12 w-12 text-muted-foreground" />
                <p className="mb-2 font-semibold text-sm">
                  {t('timetable.clickToUpload')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('timetable.dragAndDrop')}
                </p>
                <p className="mt-2 text-muted-foreground text-xs">
                  {t('timetable.supportedFormats')}
                </p>
              </>
            )}
          </button>

          {/* Status Messages */}
          {importStatus === 'success' && (
            <Alert className="border-green-500 bg-green-50 dark:bg-green-950">
              <FaCircleCheck className="h-4 w-4 text-green-600" />
              <AlertTitle>{t('timetable.importSuccessTitle')}</AlertTitle>
              <AlertDescription>
                {t('timetable.importSuccessMessage')}
              </AlertDescription>
            </Alert>
          )}

          {importStatus === 'error' && errorMessage && (
            <Alert
              className="border-red-500 bg-red-50 dark:bg-red-950"
              variant="destructive"
            >
              <FaCircleExclamation className="h-4 w-4" />
              <AlertTitle>{t('timetable.importErrorTitle')}</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3">
            <Button
              className="flex-1"
              disabled={!selectedFile || importStatus === 'uploading'}
              onClick={handleImport}
              size="lg"
            >
              {importStatus === 'uploading' ? (
                <>
                  <FaSpinner className="mr-2 h-4 w-4 animate-spin" />
                  {t('timetable.importing')}
                </>
              ) : (
                <>
                  <FaFileArrowUp className="mr-2 h-4 w-4" />
                  {t('timetable.importButton')}
                </>
              )}
            </Button>
            {selectedFile && importStatus !== 'uploading' && (
              <Button onClick={handleClearFile} size="lg" variant="outline">
                {t('common.cancel')}
              </Button>
            )}
          </div>

          {/* Information Card */}
          <Card className="bg-muted/50">
            <CardHeader>
              <CardTitle className="text-base">
                {t('timetable.importInfo')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-muted-foreground text-sm">
              <p>• {t('timetable.importInfoPoint1')}</p>
              <p>• {t('timetable.importInfoPoint2')}</p>
              <p>• {t('timetable.importInfoPoint3')}</p>
              <p>• {t('timetable.importInfoPoint4')}</p>
            </CardContent>
          </Card>
        </CardContent>
      </Card>
    </div>
  );
}
